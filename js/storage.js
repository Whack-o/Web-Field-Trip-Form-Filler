/**
 * Persist app state in localForage (equivalent to save_data.json).
 * Spreadsheet content is stored as rows, not a file path.
 */
const Storage = (() => {
  const KEY = "save_data";

  localforage.config({
    name: "FieldTripFiller",
    storeName: "save_data",
    description: "Field Trip Form Filler persisted inputs",
  });

  async function getSaveData() {
    const data = await localforage.getItem(KEY);
    return data && typeof data === "object" ? data : {};
  }

  async function writeSaveData(partial) {
    const existing = await getSaveData();
    const next = { ...existing, ...partial };
    await localforage.setItem(KEY, next);
    return next;
  }

  async function clearSaveData() {
    await localforage.removeItem(KEY);
  }

  return { getSaveData, writeSaveData, clearSaveData };
})();
