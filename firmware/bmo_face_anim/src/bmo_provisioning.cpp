// =============================================================================
// bmo_provisioning.cpp
// =============================================================================

#include "bmo_provisioning.h"

#include <Preferences.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <esp_wifi.h>
#include <nvs_flash.h>

#include "../include/secrets.h"

namespace bmo {

namespace {

constexpr const char* kNvsNamespace = "bmo";
constexpr const char* kKeySsid       = "wifi_ssid";
constexpr const char* kKeyPass       = "wifi_pass";
constexpr const char* kKeyUrl        = "dash_url";

constexpr uint32_t kConnectAttemptMs = 12000;
constexpr int      kConnectRetries   = 3;
// TX-power sweep (esp_wifi_set_max_tx_power units = 0.25 dBm) tried across
// the connect retries. The C3 SuperMini's antenna match is poor enough that
// the WPA2 handshake often only succeeds at reduced power; we sweep so a
// flaky board still lands a connection without user intervention.
//   34 = ~8.5 dBm, 52 = ~13 dBm, 78 = ~19.5 dBm
constexpr int8_t kTxSweep[]     = {34, 52, 78};
constexpr int    kTxSweepCount  = sizeof(kTxSweep) / sizeof(kTxSweep[0]);

constexpr byte kDnsPort = 53;
constexpr int  kHttpPort = 80;

// Detect the unfilled placeholder values from secrets.h.in. If the user has
// edited secrets.h with real WiFi creds, we can seed NVS with them at boot
// and skip the captive portal entirely. Useful for boards whose AP-mode RF
// is too weak for a phone to discover.
bool isPlaceholder(const char* s) {
  if (s == nullptr) return true;
  // Matches the leading "REPLACE_" prefix used in our template, plus a
  // generic "@…@" sentinel from secrets.h.in.
  if (strncmp(s, "REPLACE_", 8) == 0) return true;
  if (s[0] == '@') return true;
  return false;
}

// One-shot: write the compile-time creds into NVS if (a) they look real,
// and (b) NVS doesn't already have a matching entry. Returns true if we
// wrote anything.
bool seedNvsFromSecretsH() {
  if (isPlaceholder(BMO_WIFI_SSID) || isPlaceholder(BMO_DASHBOARD_URL)) {
    return false;
  }

  Preferences prefs;
  if (!prefs.begin(kNvsNamespace, /*readOnly=*/false)) return false;
  const String existingSsid = prefs.getString(kKeySsid, "");
  const String existingPass = prefs.getString(kKeyPass, "");
  const String existingUrl  = prefs.getString(kKeyUrl,  "");
  const bool same = existingSsid == BMO_WIFI_SSID
                 && existingPass == BMO_WIFI_PASS
                 && existingUrl  == BMO_DASHBOARD_URL;
  if (same) {
    prefs.end();
    return false;
  }
  prefs.putString(kKeySsid, BMO_WIFI_SSID);
  prefs.putString(kKeyPass, BMO_WIFI_PASS);
  prefs.putString(kKeyUrl,  BMO_DASHBOARD_URL);
  prefs.end();
  Serial.printf("[provision] seeded NVS from secrets.h: ssid='%s' url='%s'\n",
                BMO_WIFI_SSID, BMO_DASHBOARD_URL);
  return true;
}

// HTML form for the captive portal. Inline so we don't hit flash for an
// asset; same trick as a thousand ESP32 BLE-provisioning examples.
constexpr const char* kPortalHtml =
    "<!doctype html><html><head>"
    "<meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>BMO setup</title>"
    "<style>"
    "body{font-family:-apple-system,sans-serif;background:#101012;color:#eee;margin:0;padding:24px;}"
    "h1{margin:0 0 8px;font-size:22px;}"
    "p{color:#888;font-size:14px;margin:0 0 18px;}"
    "form{display:grid;gap:14px;max-width:400px;}"
    "label{font-size:13px;color:#bbb;}"
    "input{padding:10px 12px;border:1px solid #333;border-radius:8px;background:#1a1a1d;color:#eee;font-size:15px;width:100%;box-sizing:border-box;}"
    "button{padding:12px;border:0;border-radius:8px;background:#22cc88;color:#003322;font-size:16px;font-weight:600;}"
    "code{background:#1a1a1d;padding:2px 6px;border-radius:4px;font-size:12px;}"
    "</style>"
    "</head><body>"
    "<h1>Hi! I'm BMO 👾</h1>"
    "<p>Pop in the WiFi I should join, and where my dashboard lives.</p>"
    "<form method=POST action='/save'>"
    "<div><label for=ssid>WiFi name</label><input id=ssid name=ssid placeholder='your home wifi' required></div>"
    "<div><label for=pass>WiFi password</label><input id=pass name=pass type=password placeholder='wifi password' required></div>"
    "<div><label for=url>Dashboard URL</label><input id=url name=url placeholder='https://your-bmo-dashboard.vercel.app' value='https://' required></div>"
    "<button type=submit>Save and reboot</button>"
    "</form>"
    "<p style='margin-top:24px;color:#555'>Tip: hold the touch button while plugging me in to wipe and start over.</p>"
    "</body></html>";

constexpr const char* kSavedHtml =
    "<!doctype html><html><head>"
    "<meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>BMO saved</title>"
    "<style>body{font-family:-apple-system,sans-serif;background:#101012;color:#eee;padding:24px;}h1{font-size:22px;margin:0 0 12px}</style>"
    "</head><body>"
    "<h1>Saved! Restarting...</h1>"
    "<p>BMO will reboot and try to connect. You can disconnect from "
    "the <b>BMO-Setup-*</b> WiFi now and rejoin your home network.</p>"
    "</body></html>";

}  // namespace

Provisioning g_provisioning;

Provisioning::Provisioning() = default;

bool Provisioning::load() {
  Preferences prefs;
  if (!prefs.begin(kNvsNamespace, /*readOnly=*/true)) return false;
  ssid_ = prefs.getString(kKeySsid, "");
  pass_ = prefs.getString(kKeyPass, "");
  url_  = prefs.getString(kKeyUrl,  "");
  prefs.end();
  return ssid_.length() > 0 && url_.length() > 0;
}

void Provisioning::clear() {
  Preferences prefs;
  if (prefs.begin(kNvsNamespace, /*readOnly=*/false)) {
    prefs.clear();
    prefs.end();
  }
  ssid_ = "";
  pass_ = "";
  url_  = "";
}

String Provisioning::portalApName() const {
  // Use the chip's MAC tail so two BMOs in the same room don't clash.
  uint64_t mac = ESP.getEfuseMac();
  char buf[32];
  snprintf(buf, sizeof(buf), "BMO-Setup-%04X",
           static_cast<unsigned int>(mac & 0xFFFF));
  return String(buf);
}

namespace {

// Registers the disconnect-reason logger exactly once. Re-registering on
// every connect attempt (the old behaviour) stacked duplicate handlers, so
// a single failure printed N copies of "disconnect reason=...". A function
// static keeps it to one registration for the life of the process.
void ensureWifiEventLogger() {
  static bool registered = false;
  if (registered) return;
  registered = true;
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      Serial.printf("[wifi] disconnect reason=%u\n",
                    info.wifi_sta_disconnected.reason);
    }
  });
}

// Maps a wifi_auth_mode_t to a short human label for logs.
const char* authModeName(wifi_auth_mode_t m) {
  switch (m) {
    case WIFI_AUTH_OPEN:            return "OPEN";
    case WIFI_AUTH_WEP:             return "WEP";
    case WIFI_AUTH_WPA_PSK:         return "WPA-PSK";
    case WIFI_AUTH_WPA2_PSK:        return "WPA2-PSK";
    case WIFI_AUTH_WPA_WPA2_PSK:    return "WPA/WPA2-PSK";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-ENT";
    case WIFI_AUTH_WPA3_PSK:        return "WPA3-PSK";
    case WIFI_AUTH_WPA2_WPA3_PSK:   return "WPA2/WPA3-PSK";
    case WIFI_AUTH_WAPI_PSK:        return "WAPI-PSK";
    default:                        return "UNKNOWN";
  }
}

// Tries to connect to a known network. Returns true on success.
//
// `maxTxPower` is the esp_wifi_set_max_tx_power value (units of 0.25 dBm)
// applied right after WiFi.begin(). The caller sweeps this across retries
// because the ESP32-C3 SuperMini's poorly-matched PCB antenna often fails
// the WPA2 4-way handshake at high power (reason=2 / AUTH_EXPIRE) — the PA
// saturates into a reflective load and corrupts the outgoing EAPOL frames.
// Lower power can paradoxically give a cleaner signal on these boards.
//
// Robustness measures for multi-AP ("mesh"/repeater) networks like the
// triple-beacon 'FE' we observed:
//   - Full scan, then pick the STRONGEST matching BSSID and bind to it.
//   - Log each candidate's encryption mode so we can tell a wrong-password
//     failure from an auth-mode mismatch.
bool tryConnect(const String& ssid, const String& pass, uint32_t timeoutMs,
                int8_t maxTxPower) {
  if (ssid.length() == 0) return false;

  // Clean STA bring-up. WiFi.disconnect(true,true) drops any stale config
  // and clears the previous SSID/PSK so a failed attempt can't poison the
  // next one. We stay in the Arduino WiFi layer end-to-end here — mixing it
  // with raw esp_wifi_set_config() was causing "STA config failed" on the
  // 2nd/3rd attempts.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  delay(150);
  WiFi.disconnect(false, true);
  delay(100);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(false);

  ensureWifiEventLogger();

  // Scan first so we can see what BMO actually hears, and so we can bind to
  // the strongest matching BSSID below.
  Serial.println("[wifi] scanning...");
  int n = WiFi.scanNetworks(/*async=*/false, /*show_hidden=*/true);
  Serial.printf("[wifi] scan found %d network(s)\n", n);

  int bestIdx = -1;
  int bestRssi = -1000;
  for (int i = 0; i < n; ++i) {
    const String s = WiFi.SSID(i);
    const wifi_auth_mode_t enc = WiFi.encryptionType(i);
    Serial.printf("[wifi]   %2d: rssi=%4d ch=%2d enc=%-13s %s\n",
                  i, WiFi.RSSI(i), WiFi.channel(i), authModeName(enc),
                  s.c_str());
    if (s == ssid && WiFi.RSSI(i) > bestRssi) {
      bestRssi = WiFi.RSSI(i);
      bestIdx = i;
    }
  }

  if (bestIdx < 0) {
    Serial.printf("[wifi] WARNING: target SSID '%s' not visible in scan\n",
                  ssid.c_str());
    WiFi.scanDelete();
    return false;
  }

  // Capture the winning BSSID + channel + encryption before we delete the
  // scan results.
  uint8_t targetBssid[6];
  memcpy(targetBssid, WiFi.BSSID(bestIdx), 6);
  const int32_t targetChannel = WiFi.channel(bestIdx);
  const wifi_auth_mode_t targetEnc = WiFi.encryptionType(bestIdx);
  Serial.printf("[wifi] best '%s' node: rssi=%d ch=%d enc=%s "
                "bssid=%02X:%02X:%02X:%02X:%02X:%02X\n",
                ssid.c_str(), bestRssi, static_cast<int>(targetChannel),
                authModeName(targetEnc),
                targetBssid[0], targetBssid[1], targetBssid[2],
                targetBssid[3], targetBssid[4], targetBssid[5]);
  WiFi.scanDelete();

  if (targetEnc == WIFI_AUTH_WPA3_PSK) {
    Serial.println("[wifi] NOTE: AP is WPA3-only; the C3 supports WPA3 but "
                   "some AP firmwares reject it. If this keeps failing, set "
                   "the router to WPA2/WPA3-mixed.");
  }

  Serial.printf("[wifi] connecting to %s...\n", ssid.c_str());
  Serial.printf("[wifi] (debug) ssid_len=%d pass_len=%d\n",
                static_cast<int>(ssid.length()),
                static_cast<int>(pass.length()));

  // Bind to the specific strongest BSSID + channel. This is the key fix for
  // multi-AP 'FE': it forces association with the closest node instead of
  // letting the driver roam to a weak one and time out on auth.
  WiFi.begin(ssid.c_str(), pass.c_str(), targetChannel, targetBssid);
  // C3 SuperMini antenna workaround: apply the swept tx power. Setting it
  // after begin() (when the PHY is actually up) is what makes it stick.
  esp_wifi_set_max_tx_power(maxTxPower);
  Serial.printf("[wifi] tx power set to %d (~%.1f dBm)\n",
                static_cast<int>(maxTxPower),
                static_cast<double>(maxTxPower) / 4.0);

  const uint32_t deadline = millis() + timeoutMs;
  wl_status_t lastStatus = WL_IDLE_STATUS;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
    wl_status_t s = WiFi.status();
    if (s != lastStatus) {
      Serial.printf("[wifi] status=%d\n", static_cast<int>(s));
      lastStatus = s;
    }
    delay(150);
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[wifi] connect timeout (last status=%d)\n",
                  static_cast<int>(WiFi.status()));
    WiFi.disconnect(true, true);
    return false;
  }
  Serial.printf("[wifi] connected, ip=%s rssi=%d\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  return true;
}

// Runs the captive portal until the user submits credentials or the
// timeout expires. Mutates `prov`'s cached fields and saves to NVS on
// success. Returns true on a save.
bool runPortal(Provisioning& prov, uint32_t timeoutSeconds, void (*tick)()) {
  // Keep this path *boring* and Android-friendly:
  //   1. Don't toggle WiFi mode multiple times — some Android phones cache
  //      a "this AP is unstable" verdict from the first beacon they see.
  //   2. Open network (no password) — every Android version we've tested
  //      handles open networks more reliably than WPA2 PSK with short
  //      passwords, especially while the phone is on a 5 GHz home network.
  //   3. Channel 6 — most Android phones bias their 2.4 GHz scan towards
  //      channels 1, 6, 11; channel 6 is the universally safe middle.
  //   4. Set country code "01" (world) explicitly so the AP advertises
  //      regulatory info — some Android builds silently hide APs that
  //      don't beacon a country IE.
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  delay(300);
  WiFi.setSleep(false);

  // Country IE — tells phones what regulatory domain we're in.
  wifi_country_t country = {};
  memcpy(country.cc, "01", 2);
  country.schan = 1;
  country.nchan = 13;
  country.policy = WIFI_COUNTRY_POLICY_MANUAL;
  esp_wifi_set_country(&country);

  const String apName = prov.portalApName();
  Serial.printf("[provision] bringing up AP '%s' (open network, channel 6)\n",
                apName.c_str());

  IPAddress apIp(192, 168, 4, 1);
  if (!WiFi.softAPConfig(apIp, apIp, IPAddress(255, 255, 255, 0))) {
    Serial.println("[provision] softAPConfig failed");
  }
  delay(100);

  // Open AP (empty password). Channel 6, max 4 clients.
  bool apOk = WiFi.softAP(apName.c_str(),
                          /*password=*/nullptr,
                          /*channel=*/6,
                          /*ssid_hidden=*/0,
                          /*max_connection=*/4);
  if (!apOk) {
    Serial.println("[provision] softAP first attempt failed; resetting and retrying");
    WiFi.mode(WIFI_OFF);
    delay(500);
    WiFi.mode(WIFI_AP);
    delay(400);
    apOk = WiFi.softAP(apName.c_str(),
                       /*password=*/nullptr,
                       /*channel=*/6,
                       /*ssid_hidden=*/0,
                       /*max_connection=*/4);
  }
  if (!apOk) {
    Serial.println("[provision] softAP refused after retry; aborting portal");
    return false;
  }
  delay(500);

  // Now that the AP is actually up, crank tx power. Setting it before the
  // AP starts is a silent no-op and was a real bug in earlier revisions.
  WiFi.setTxPower(WIFI_POWER_19_5dBm);

  // ESP32-C3 Super Mini RF workaround: many of these tiny boards have a
  // marginal antenna match. Drop down to 802.11b only (long-range, robust)
  // and try a *low* tx power — counterintuitively, on a broken antenna
  // match, a lower drive level can radiate more usable signal because the
  // PA isn't saturating into a reflective load.
  esp_wifi_set_protocol(WIFI_IF_AP, WIFI_PROTOCOL_11B);
  esp_wifi_set_max_tx_power(34);  // 34 = 8.5 dBm (units are 0.25 dBm)
  // Some C3 boards radiate ~10 dB stronger after a cold reinit of PHY.
  // Toggle the AP off/on once to force PHY recalibration.
  WiFi.softAPdisconnect(false);
  delay(200);
  WiFi.softAP(apName.c_str(),
              /*password=*/nullptr,
              /*channel=*/6,
              /*ssid_hidden=*/0,
              /*max_connection=*/4);
  delay(400);
  esp_wifi_set_protocol(WIFI_IF_AP, WIFI_PROTOCOL_11B);
  esp_wifi_set_max_tx_power(34);

  Serial.printf("[provision] AP up: SSID='%s' bssid=%s ip=%s\n",
                WiFi.softAPSSID().c_str(),
                WiFi.softAPmacAddress().c_str(),
                WiFi.softAPIP().toString().c_str());
  Serial.printf("[provision] portal: http://%s/  (open network, no password)\n",
                WiFi.softAPIP().toString().c_str());

  // Captive-DNS: respond to every query with our AP IP so the phone's
  // captive portal sniffer pops the page automatically.
  DNSServer dns;
  dns.start(kDnsPort, "*", apIp);

  WebServer server(kHttpPort);

  bool saved = false;

  server.on("/", HTTP_GET, [&]() {
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "text/html", kPortalHtml);
  });
  server.on("/save", HTTP_POST, [&]() {
    String s = server.arg("ssid");
    String p = server.arg("pass");
    String u = server.arg("url");
    s.trim(); p.trim(); u.trim();
    // Strip any trailing slash on the dashboard URL — the brain client
    // appends `/api/brain` itself.
    while (u.endsWith("/")) u.remove(u.length() - 1);
    if (s.length() == 0 || u.length() == 0) {
      server.send(400, "text/plain", "ssid and url are required");
      return;
    }
    Preferences prefs;
    if (!prefs.begin(kNvsNamespace, /*readOnly=*/false)) {
      server.send(500, "text/plain", "nvs unavailable");
      return;
    }
    prefs.putString(kKeySsid, s);
    prefs.putString(kKeyPass, p);
    prefs.putString(kKeyUrl,  u);
    prefs.end();
    Serial.printf("[provision] saved ssid=%s url=%s\n",
                  s.c_str(), u.c_str());
    server.send(200, "text/html", kSavedHtml);
    saved = true;
  });
  // Common captive-portal probe endpoints — make the OS think it's online
  // *only* via our portal, so the phone surfaces the form automatically.
  auto sendPortalRedirect = [&]() {
    server.sendHeader("Location", "/", true);
    server.send(302, "text/plain", "");
  };
  server.on("/generate_204", HTTP_GET, sendPortalRedirect);          // Android
  server.on("/hotspot-detect.html", HTTP_GET, sendPortalRedirect);   // Apple
  server.on("/connecttest.txt", HTTP_GET, sendPortalRedirect);       // Windows
  server.on("/redirect", HTTP_GET, sendPortalRedirect);
  server.onNotFound(sendPortalRedirect);

  server.begin();

  const uint32_t deadline = millis() + timeoutSeconds * 1000UL;
  uint32_t lastTick = 0;
  while (millis() < deadline && !saved) {
    dns.processNextRequest();
    server.handleClient();
    if (tick != nullptr) {
      // Cap render cadence to ~50 Hz so we don't starve the HTTP loop on
      // a phone that's hammering captive-portal probe endpoints.
      const uint32_t now = millis();
      if (now - lastTick >= 20) {
        lastTick = now;
        tick();
      }
    }
    delay(2);
  }

  // Give the saved-page response time to fly out before we tear the AP down.
  if (saved) delay(800);

  server.stop();
  dns.stop();
  WiFi.softAPdisconnect(true);
  return saved;
}

}  // namespace

bool Provisioning::ensureProvisionedAndConnected(uint32_t portalTimeoutSeconds,
                                                 void (*tick)()) {
  // Compile-time creds (from include/secrets.h) win when the file has been
  // filled in by the user. This bypasses the captive portal entirely —
  // important for the C3 Super Mini whose softAP signal is often too weak
  // for a phone to discover. The seed runs every boot but only writes when
  // the values change.
  seedNvsFromSecretsH();

  load();

  // Decide up front: do we have anything worth trying? If not, skip straight
  // to the portal so the user doesn't have to wait through ~16s of doomed
  // retries on first boot.
  if (ssid_.length() == 0 || url_.length() == 0) {
    Serial.println("[provision] no saved credentials; skipping straight to portal");
  } else {
    Serial.printf("[provision] saved creds present (ssid='%s' url='%s'); will try them first\n",
                  ssid_.c_str(), url_.c_str());
    // C3 SuperMini antenna sweep: many of these boards only complete the
    // WPA2 handshake at reduced tx power (the PA saturates into a badly
    // matched antenna at full power, corrupting EAPOL frames -> reason=2).
    // Sweep from low to high so a flaky board gets its best shot first.
    // (kTxSweep / kTxSweepCount are defined at namespace scope above.)
    for (int attempt = 0; attempt < kConnectRetries; ++attempt) {
      const int8_t tx = kTxSweep[attempt % kTxSweepCount];
      Serial.printf("[provision] connect attempt %d / %d (tx=%d)\n",
                    attempt + 1, kConnectRetries, static_cast<int>(tx));
      if (tryConnect(ssid_, pass_, kConnectAttemptMs, tx)) return true;
      delay(500);
    }
    Serial.printf("[provision] %d attempts on '%s' failed\n",
                  kConnectRetries, ssid_.c_str());

    // Compile-time fallback network. Useful when the primary WiFi is down
    // or out of range — BMO will quietly hop onto the secondary instead of
    // dropping into the captive portal. Only kicks in when:
    //   1) include/secrets.h defines BMO_WIFI_SSID2 with a real value, and
    //   2) the secondary differs from whatever's currently saved in NVS.
#if defined(BMO_WIFI_SSID2) && defined(BMO_WIFI_PASS2)
    if (!isPlaceholder(BMO_WIFI_SSID2) &&
        ssid_ != BMO_WIFI_SSID2) {
      Serial.printf("[provision] trying fallback network '%s'\n",
                    BMO_WIFI_SSID2);
      for (int attempt = 0; attempt < kConnectRetries; ++attempt) {
        const int8_t tx = kTxSweep[attempt % (sizeof(kTxSweep) / sizeof(kTxSweep[0]))];
        Serial.printf("[provision] fallback attempt %d / %d (tx=%d)\n",
                      attempt + 1, kConnectRetries, static_cast<int>(tx));
        if (tryConnect(BMO_WIFI_SSID2, BMO_WIFI_PASS2, kConnectAttemptMs, tx)) {
          // Update the in-memory cache so the brain client logs the SSID
          // we actually associated with. We deliberately don't persist
          // this to NVS: seedNvsFromSecretsH() runs every boot and would
          // overwrite it anyway, and we want the next boot to re-prefer
          // the primary network without flipping the priority order.
          ssid_ = BMO_WIFI_SSID2;
          pass_ = BMO_WIFI_PASS2;
          return true;
        }
        delay(500);
      }
      Serial.println("[provision] fallback also failed");
    }
#endif

    Serial.println("[provision] all known networks failed; falling back to portal");
  }

  // No saved creds, or connect failed every retry — drop into the portal.
  Serial.println("[provision] entering captive portal");
  if (!runPortal(*this, portalTimeoutSeconds, tick)) {
    Serial.println("[provision] portal timed out without a save");
    return false;
  }

  // Re-read what we just saved and reboot. A clean reboot makes the rest of
  // the firmware come up cleanly; the WiFi stack on this chip is happier
  // re-initialised from scratch than torn-down-then-up.
  Serial.println("[provision] rebooting to apply new credentials...");
  delay(200);
  ESP.restart();
  return false;  // unreachable
}

}  // namespace bmo
