// bb-plugin-aim — an AOL Instant Messenger-style desktop for bb-app.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
//
// There is exactly ONE AIM surface: the desktop page, reached from its own
// sidebar entry. It is registered as a `navPanel` (which gets a sidebar item
// and a host-wrapped panel route) and renders the classic-Windows desktop,
// the buddy list, and the floating IM windows. The former always-on
// `experimental_appOverlay` registration is intentionally removed so the AIM
// chrome only exists on this page.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DesktopPage } from "./aim/DesktopPage";
// Window chrome (our own, scoped under .aim-xp). This replaces the vendored
// 98.css bundle: the AIM desktop is a light retro IM client, not a Windows 98
// shell, and shipping the whole OS design system kept dragging the layout back
// toward a 1998 desktop instead of giving space to thread detail and the real
// chat. aim/chrome.css defines only the primitives the components use.
import "./aim/chrome.css";
// The AIM palette and page layout layer, loaded after chrome.css so it can
// restyle the chrome.
import "./aim.css";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "aim-desktop",
    title: "AIM",
    icon: "Monitor",
    // Routed at /plugins/aim/aim-desktop; the component receives the
    // remainder as `subPath` (always "" here).
    path: "desktop",
    component: DesktopPage,
  });
});