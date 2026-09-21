/* OPD_diff -- MV3 service worker.
 *
 * Deliberately tiny. A service worker is evicted whenever the browser feels like
 * it, so it holds no state: the capture lives in chrome.storage.local, written
 * by the content script and read by the viewer tab. All this does is open tabs
 * and relay a click.
 */
"use strict";

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== "open-viewer") return false;
  chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") }, function (tab) {
    sendResponse({ ok: true, tabId: tab && tab.id });
  });
  // Keeps the message channel open for the async sendResponse above.
  return true;
});

/* The toolbar button is a second way in, for when the floating button is hidden
 * behind one of the HIS's own modal overlays. It only ever talks to a tab the
 * content script is already running in; if it is not there, nothing happens. */
chrome.action.onClicked.addListener(function (tab) {
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: "toggle-overlay" }, function () {
    // Reading lastError is what suppresses the "receiving end does not exist"
    // console noise on pages where no content script is loaded.
    void chrome.runtime.lastError;
  });
});
