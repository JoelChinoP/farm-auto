---
name: farm-mobile-automation
description: Use when working with Android, ADB, Appium, UiAutomator2, device setup, mobile flows, screenshots, selectors, or physical-device tests in farm-appium.
---

# Farm Mobile Automation

1. Read `ANALISIS_FARM_AUTO.md` before changing a product flow.
2. Use the Android MCP for discovery, screenshots, UI trees, installed apps and logcat.
3. Use the Appium MCP to validate selectors and behavioral flows. Keep MCP sessions separate from application-owned sessions.
4. If several devices are connected, pass the serial and a unique UiAutomator2 `systemPort` explicitly.
5. Start with non-destructive checks: device list, Home, page source, foreground package and safe deep links.
6. Run public social actions only when the user explicitly requests them and identifies controlled content.
7. If an external effect may have happened but cannot be verified, stop and preserve evidence as `outcome_unknown`.
8. Prefer accessibility ID or resource ID, then bounded text matching; use coordinates only for calibrated gestures.
