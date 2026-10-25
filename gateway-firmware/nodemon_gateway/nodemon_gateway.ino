/*
 * Nodemon gateway firmware (ESP32).
 * BLE scan -> parse tag packet -> entry/exit/tamper detection -> MQTT to Azure IoT Hub.
 *
 * Libraries (Library Manager): NimBLE-Arduino 1.4.x (NOT 2.x), PubSubClient, ArduinoJson 7.x.
 * Board: "ESP32 Dev Module". Copy secrets.h.example to secrets.h first.
 *
 * Tag packet (manufacturer data, little-endian):
 *   [0-1] company id 0xFFFF | [2-3] tag_id u16 | [4] motion | [5] tamper | [6] battery %
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <time.h>
#include "secrets.h"
#include "iothub_sas.h"

// ---------- tunables (adjust on site) ----------
constexpr uint16_t COMPANY_ID        = 0xFFFF;
constexpr int      RSSI_MIN_DBM      = -80;     // ignore adverts weaker than this (outside the zone)
constexpr uint8_t  ENTER_HITS        = 2;       // consecutive scans seen before "entry"
constexpr uint32_t ABSENT_MS         = 30000;   // unseen this long -> "exit" (> tag sleep of 10-15 s)
constexpr uint32_t SCAN_SECONDS      = 2;
constexpr uint32_t HEARTBEAT_MS      = 120000;
constexpr uint32_t TAMPER_COOLDOWN_MS = 10000;  // dedup repeated tamper reports
constexpr uint32_t SAS_TTL_S         = 86400;
constexpr size_t   MAX_TAGS          = 16;
constexpr size_t   QUEUE_MAX         = 30;      // events buffered while offline
constexpr int      LED_PIN           = 2;

struct Tag {
  bool used = false, present = false, seen = false, tamperPending = false;
  uint16_t id = 0; uint8_t hits = 0, motion = 0, battery = 0;
  int rssi = -127; uint32_t lastSeen = 0, lastTamperSent = 0;
};
Tag tags[MAX_TAGS];

String queueBuf[QUEUE_MAX]; size_t qHead = 0, qCount = 0;
WiFiClientSecure net; PubSubClient mqtt(net);
uint32_t lastHeartbeat = 0, lastMqttTry = 0;
const String topic = String("devices/") + DEVICE_ID + "/messages/events/$.ct=application%2Fjson&$.ce=utf-8";

// ---------- helpers ----------
String isoNow() {
  time_t t = time(nullptr); struct tm tm; gmtime_r(&t, &tm);
  char b[25]; strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", &tm);
  return String(b);
}

void enqueue(const String &json) {
  if (qCount == QUEUE_MAX) { qHead = (qHead + 1) % QUEUE_MAX; qCount--; }  // drop oldest
  queueBuf[(qHead + qCount) % QUEUE_MAX] = json; qCount++;
}

void queueEvent(const char *type, const Tag &t) {
  JsonDocument d;
  d["gateway_id"] = DEVICE_ID; d["zone_id"] = ZONE_ID; d["tag_id"] = t.id;
  d["event_type"] = type; d["motion_flag"] = t.motion;
  d["tamper_flag"] = strcmp(type, "tamper") == 0 ? 1 : 0;
  d["battery_pct"] = t.battery; d["rssi"] = t.rssi; d["timestamp"] = isoNow();
  String s; serializeJson(d, s); enqueue(s);
  Serial.printf("[evt] %s tag=%u rssi=%d\n", type, t.id, t.rssi);
}

void queueHeartbeat() {
  JsonDocument d;
  d["gateway_id"] = DEVICE_ID; d["zone_id"] = ZONE_ID; d["event_type"] = "heartbeat";
  JsonArray present = d["tags_present"].to<JsonArray>();
  for (auto &t : tags) if (t.used && t.present) present.add(t.id);
  d["timestamp"] = isoNow();
  String s; serializeJson(d, s); enqueue(s);
}

// ---------- BLE ----------
class AdvCb : public NimBLEAdvertisedDeviceCallbacks {
  void onResult(NimBLEAdvertisedDevice *d) override {
    if (!d->haveManufacturerData()) return;
    std::string md = d->getManufacturerData();
    if (md.size() < 7) return;
    const uint8_t *p = (const uint8_t *)md.data();
    if ((uint16_t)(p[0] | (p[1] << 8)) != COMPANY_ID) return;
    int rssi = d->getRSSI();
    if (rssi < RSSI_MIN_DBM) return;
    uint16_t id = p[2] | (p[3] << 8);
    Tag *slot = nullptr;
    for (auto &t : tags) { if (t.used && t.id == id) { slot = &t; break; } }
    if (!slot) for (auto &t : tags) { if (!t.used) { t.used = true; t.id = id; slot = &t; break; } }
    if (!slot) return;
    slot->seen = true; slot->lastSeen = millis(); slot->rssi = rssi;
    slot->motion = p[4]; slot->battery = p[6];
    if (p[5]) slot->tamperPending = true;
  }
} advCb;

void updateStateMachine() {
  uint32_t now = millis();
  for (auto &t : tags) {
    if (!t.used) continue;
    if (t.seen) {
      if (t.hits < 255) t.hits++;
      if (!t.present && t.hits >= ENTER_HITS) { t.present = true; queueEvent("entry", t); }
    } else t.hits = 0;
    if (t.present && now - t.lastSeen > ABSENT_MS) { t.present = false; t.hits = 0; queueEvent("exit", t); }
    if (t.tamperPending && now - t.lastTamperSent > TAMPER_COOLDOWN_MS) {
      queueEvent("tamper", t); t.lastTamperSent = now;
      t.tamperPending = false;   // only clear after a successful send, not on cooldown suppression
    }
    t.seen = false;
  }
}

// ---------- network ----------
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("[wifi] connecting");
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print('.'); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " ok" : " failed (will retry)");
}

void syncTime() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  for (int i = 0; i < 40 && time(nullptr) < 1700000000; i++) delay(250);
  Serial.println(time(nullptr) < 1700000000 ? "[time] NTP failed" : "[time] synced");
}

bool connectMqtt() {
  if (time(nullptr) < 1700000000) { syncTime(); if (time(nullptr) < 1700000000) return false; }
  String user = String(IOTHUB_HOST) + "/" + DEVICE_ID + "/?api-version=2021-04-12";
  String sas = makeSasToken(IOTHUB_HOST, DEVICE_ID, DEVICE_KEY, time(nullptr) + SAS_TTL_S);
  if (sas.isEmpty()) { Serial.println("[mqtt] bad DEVICE_KEY"); return false; }
  bool ok = mqtt.connect(DEVICE_ID, user.c_str(), sas.c_str());
  Serial.printf("[mqtt] connect %s (state %d)\n", ok ? "ok" : "failed", mqtt.state());
  return ok;
}

void flushQueue() {
  while (qCount > 0 && mqtt.connected()) {
    if (!mqtt.publish(topic.c_str(), queueBuf[qHead].c_str())) break;  // keep it, retry later
    digitalWrite(LED_PIN, HIGH); delay(20); digitalWrite(LED_PIN, LOW);
    qHead = (qHead + 1) % QUEUE_MAX; qCount--;
  }
}

void setup() {
  Serial.begin(115200); pinMode(LED_PIN, OUTPUT);
  ensureWifi(); syncTime();
#ifdef IOTHUB_ROOT_CA
  net.setCACert(IOTHUB_ROOT_CA);
#else
  net.setInsecure();   // demo only: no server certificate validation
#endif
  mqtt.setServer(IOTHUB_HOST, 8883); mqtt.setBufferSize(1024); mqtt.setKeepAlive(60);

  NimBLEDevice::init("");
  NimBLEScan *scan = NimBLEDevice::getScan();
  scan->setAdvertisedDeviceCallbacks(&advCb, true);
  scan->setActiveScan(false); scan->setInterval(100); scan->setWindow(99);
  Serial.printf("[boot] %s zone=%s\n", DEVICE_ID, ZONE_ID);
}

void loop() {
  NimBLEDevice::getScan()->start(SCAN_SECONDS, false);   // blocking scan window
  NimBLEDevice::getScan()->clearResults();
  updateStateMachine();

  if (millis() - lastHeartbeat > HEARTBEAT_MS) { queueHeartbeat(); lastHeartbeat = millis(); }

  ensureWifi();
  if (WiFi.status() == WL_CONNECTED && !mqtt.connected() && millis() - lastMqttTry > 5000) {
    lastMqttTry = millis(); connectMqtt();
  }
  mqtt.loop();
  flushQueue();
}
