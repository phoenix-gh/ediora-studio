const KEY = "wemedia_auto_browse";
const toggle = document.getElementById("autoBrowseToggle");

chrome.storage.local.get([KEY], (res) => {
  toggle.checked = !!res[KEY];
});

toggle.addEventListener("change", () => {
  chrome.storage.local.set({ [KEY]: toggle.checked });
});
