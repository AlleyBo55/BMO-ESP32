// =============================================================================
// bmo_provisioning.h
//
// Phone-friendly first-run setup. Stores WiFi credentials and the dashboard
// URL in the chip's NVS partition so they survive reboots, and runs a
// captive-portal AP ("BMO-Setup") when no creds exist yet — or when the
// user wipes them with a long hold at boot.
//
// API surface stays small on purpose: the brain client doesn't need to
// know how creds were obtained, just that they're present and current.
// =============================================================================

#pragma once

#include <Arduino.h>

namespace bmo {

class Provisioning {
 public:
  Provisioning();

  // Reads the saved credentials from NVS into the in-memory cache. Returns
  // true if all three fields are populated. Called by `begin()` itself, but
  // exposed in case the caller wants to know the state without triggering
  // the portal.
  bool load();

  // Wipes every saved field. Used by the factory-reset gesture (touch
  // held 3+ seconds at boot).
  void clear();

  // Connects to WiFi using the saved creds. If creds are missing or the
  // connection fails after a few attempts, starts the captive portal AP
  // and *blocks* until the user submits the form. After submission this
  // saves the new values to NVS, prints them (without secrets), and
  // restarts the chip so the new firmware run picks them up cleanly.
  //
  // Returns true if WiFi is connected on exit, false only if the user never
  // completed the portal within the timeout.
  //
  // `tick` (when non-null) is invoked from the portal loop ~50 Hz so the
  // caller can drive a face animation while the portal blocks. It must
  // not block — keep each call to a single render pass.
  bool ensureProvisionedAndConnected(uint32_t portalTimeoutSeconds = 600,
                                     void (*tick)() = nullptr);

  // Cached, post-load accessors. Empty strings until `load()` succeeds.
  const String& wifiSsid()     const { return ssid_; }
  const String& wifiPass()     const { return pass_; }
  const String& dashboardUrl() const { return url_; }

  // Renders a short message on stdout describing how to reach the portal.
  // Useful in the LCD portal screen too.
  String portalApName() const;
  static const char* portalPassword() { return "bmosetup"; }

 private:
  String ssid_;
  String pass_;
  String url_;
};

// Process-wide singleton. Construct once in main.cpp; pass via global ref.
extern Provisioning g_provisioning;

}  // namespace bmo
