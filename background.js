// Open side panel when the extension icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// ── Port-based messaging for reliable content script → side panel relay ──
// Side panel connects via port. Content script sends runtime messages.
// Background relays between them.

let sidePanelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    sidePanelPort = port;
    console.log("[Ditto BG] Side panel connected");
    port.onDisconnect.addListener(() => {
      sidePanelPort = null;
      console.log("[Ditto BG] Side panel disconnected");
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "invested_hover" && sender.tab) {
    console.log("[Ditto BG] Hover received:", msg.term, "port:", !!sidePanelPort);
    if (sidePanelPort) {
      try {
        sidePanelPort.postMessage(msg);
      } catch (e) {
        console.warn("[Ditto BG] Port relay failed:", e);
        sidePanelPort = null;
      }
    }
  }
});