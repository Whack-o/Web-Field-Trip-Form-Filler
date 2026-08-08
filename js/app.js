/**
 * Field Trip Form Filler — browser UI + search/selection logic
 * Port of old_app Tkinter CadetSearchTool / SearchLogic.
 */
(() => {
  const REQUIRED_COLUMNS = [
    "First Name",
    "Last Name",
    "Student ID",
    "Grade",
    "Address",
    "Phone Number",
  ];

  const state = {
    rows: [],
    spreadsheetName: "",
    selectedCadets: [], // strings like "First Last (ID) [rowIndex]"
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheEls();
    bindEvents();
    await restoreFromStorage();
    renderSelected();
    updateSearch();
    updateSpreadsheetStatus();
    // Warm pypdf engine in the background (first Generate is then much faster)
    if (typeof FormFiller !== "undefined" && FormFiller.prefetch) {
      FormFiller.prefetch().catch((err) => {
        console.warn("PDF engine prefetch failed:", err);
      });
    }
  }

  function cacheEls() {
    els.fileInput = document.getElementById("spreadsheet-input");
    els.spreadsheetLabel = document.getElementById("spreadsheet-label");
    els.spreadsheetStatus = document.getElementById("spreadsheet-status");
    els.outputName = document.getElementById("output-name");
    els.searchInput = document.getElementById("search-input");
    els.resultsList = document.getElementById("results-list");
    els.selectedList = document.getElementById("selected-list");
    els.selectedCount = document.getElementById("selected-count");
    els.generateBtn = document.getElementById("generate-btn");
    els.removeBtn = document.getElementById("remove-btn");
    els.clearBtn = document.getElementById("clear-btn");
    els.helpBtn = document.getElementById("help-btn");
    els.helpModal = document.getElementById("help-modal");
    els.helpClose = document.getElementById("help-close");
    els.toast = document.getElementById("toast");
  }

  function bindEvents() {
    els.fileInput.addEventListener("change", onSpreadsheetSelected);
    els.searchInput.addEventListener("input", updateSearch);
    els.outputName.addEventListener("input", debounce(persistOutputName, 300));
    els.generateBtn.addEventListener("click", generateForm);
    els.removeBtn.addEventListener("click", removeSelectedCadet);
    els.clearBtn.addEventListener("click", clearList);
    els.helpBtn.addEventListener("click", () => openModal(true));
    els.helpClose.addEventListener("click", () => openModal(false));
    els.helpModal.addEventListener("click", (e) => {
      if (e.target === els.helpModal) openModal(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") openModal(false);
    });
  }

  async function restoreFromStorage() {
    const saved = await Storage.getSaveData();

    if (Array.isArray(saved.selected_cadets)) {
      state.selectedCadets = saved.selected_cadets.filter(
        (c) => typeof c === "string" && c.length > 0
      );
    }

    if (typeof saved.outputName === "string") {
      els.outputName.value = saved.outputName;
    }

    if (Array.isArray(saved.spreadsheetData) && saved.spreadsheetData.length) {
      state.rows = saved.spreadsheetData.map(normalizeRow);
      state.spreadsheetName = saved.spreadsheetName || "Saved spreadsheet";
    }
  }

  async function persistCadets() {
    await Storage.writeSaveData({ selected_cadets: state.selectedCadets });
  }

  async function persistOutputName() {
    await Storage.writeSaveData({ outputName: els.outputName.value.trim() });
  }

  async function persistSpreadsheet() {
    await Storage.writeSaveData({
      spreadsheetName: state.spreadsheetName,
      spreadsheetData: state.rows,
    });
  }

  async function onSpreadsheetSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    try {
      const { rows, columns } = await parseSpreadsheetFile(file);

      const normalizedColumns = (columns || []).map(normalizeHeader);
      const missingCols = REQUIRED_COLUMNS.filter(
        (col) => !normalizedColumns.includes(col)
      );

      if (missingCols.length) {
        showToast(
          `Missing required columns: ${missingCols.join(", ")}`,
          "error"
        );
        event.target.value = "";
        return;
      }

      state.rows = rows
        .map(normalizeRow)
        .filter((r) =>
          REQUIRED_COLUMNS.some((col) => String(r[col] || "").trim() !== "")
        );
      state.spreadsheetName = file.name;
      await persistSpreadsheet();
      updateSpreadsheetStatus();
      updateSearch();
      showToast(`Loaded ${state.rows.length} cadets from ${file.name}`, "ok");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Failed to read spreadsheet.", "error");
      event.target.value = "";
    }
  }

  function normalizeHeader(header) {
    return String(header ?? "")
      .replace(/^\uFEFF/, "")
      .trim();
  }

  function normalizeRow(row) {
    const out = {};
    const source = row && typeof row === "object" ? row : {};

    // Rebuild with trimmed keys (handles Excel BOM / stray spaces)
    const cleaned = {};
    Object.keys(source).forEach((key) => {
      cleaned[normalizeHeader(key)] = source[key];
    });

    REQUIRED_COLUMNS.forEach((col) => {
      const val = cleaned[col];
      out[col] = val == null ? "" : String(val);
    });

    Object.keys(cleaned).forEach((k) => {
      if (!(k in out)) {
        const val = cleaned[k];
        out[k] = val == null ? "" : String(val);
      }
    });
    return out;
  }

  function parseSpreadsheetFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "csv") {
      return parseCsv(file);
    }
    if (ext === "xlsx" || ext === "xls") {
      return parseExcel(file);
    }
    return Promise.reject(
      new Error("Please upload a .csv, .xlsx, or .xls spreadsheet.")
    );
  }

  function parseCsv(file) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: "greedy",
        transformHeader: (h) => normalizeHeader(h),
        complete: (results) => {
          if (results.errors && results.errors.length) {
            const fatal = results.errors.filter((e) => e.type === "Delimiter");
            if (fatal.length) {
              reject(new Error(fatal[0].message || "Could not parse CSV."));
              return;
            }
            console.warn(results.errors);
          }

          const columns = (results.meta.fields || []).map(normalizeHeader);
          const rows = (results.data || []).map(cleanParsedRow);
          resolve({ rows, columns });
        },
        error: (err) => reject(err),
      });
    });
  }

  function parseExcel(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];

          // First row as headers (same spirit as pandas)
          const headerMatrix = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            defval: "",
            raw: false,
          });
          const headerRow = headerMatrix[0] || [];
          const columns = headerRow.map(normalizeHeader).filter((c) => c !== "");

          const json = XLSX.utils.sheet_to_json(sheet, {
            defval: "",
            raw: false,
          });
          const rows = json.map(cleanParsedRow);
          resolve({ rows, columns });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error("Could not read the Excel file."));
      reader.readAsArrayBuffer(file);
    });
  }

  function cleanParsedRow(row) {
    const cleaned = {};
    Object.keys(row || {}).forEach((key) => {
      const trimmedKey = normalizeHeader(key);
      if (!trimmedKey) return;
      const val = row[key];
      cleaned[trimmedKey] =
        val == null || val === "NaN" || val === "null" ? "" : String(val).trim();
    });
    return cleaned;
  }

  function updateSpreadsheetStatus() {
    if (state.rows.length) {
      els.spreadsheetLabel.textContent = state.spreadsheetName;
      els.spreadsheetStatus.classList.add("ready");
      els.spreadsheetStatus.title = `${state.rows.length} rows loaded`;
    } else {
      els.spreadsheetLabel.textContent = "No spreadsheet loaded";
      els.spreadsheetStatus.classList.remove("ready");
      els.spreadsheetStatus.title = "";
    }
  }

  function updateSearch() {
    const query = els.searchInput.value.trim().toLowerCase();
    els.resultsList.innerHTML = "";

    if (!state.rows.length) {
      els.resultsList.innerHTML =
        '<p class="text-sm text-[var(--muted)] p-3">Please upload a spreadsheet with cadet data.</p>';
      return;
    }

    if (!query) {
      els.resultsList.innerHTML =
        '<p class="text-sm text-[var(--muted)] p-3">Type to search by name, ID, or other identifying information.</p>';
      return;
    }

    const queries = query.split(/\s+/).filter(Boolean);
    const scored = state.rows
      .map((row, index) => ({
        row,
        index,
        score: relevanceScore(row, queries),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    if (!scored.length) {
      els.resultsList.innerHTML =
        '<p class="text-sm text-[var(--muted)] p-3">No matching cadets.</p>';
      return;
    }

    scored.forEach(({ row, index }) => {
      els.resultsList.appendChild(createCadetResult(row, index));
    });
  }

  function relevanceScore(row, queries) {
    const values = Object.values(row || {}).map((v) =>
      String(v ?? "").toLowerCase()
    );
    let score = 0;
    queries.forEach((word) => {
      if (values.some((v) => v.includes(word))) score += 1;
    });
    return score;
  }

  function createCadetResult(row, index) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "cadet-result w-full text-left border border-[var(--line)] rounded-md px-3 py-2 mb-2 bg-white";
    const parts = Object.entries(row)
      .filter(([k]) => k !== "relevance")
      .map(([k, v]) => `${k}: ${v ?? ""}`);
    btn.innerHTML = `<div class="text-sm leading-snug break-words">${escapeHtml(
      parts.join(" | ")
    )}</div>`;
    btn.addEventListener("click", () => addCadet(row, index));
    return btn;
  }

  function cadetLabel(row, index) {
    const id =
      row["Student ID"] && String(row["Student ID"]).trim() !== ""
        ? row["Student ID"]
        : "NO ID";
    return `${row["First Name"] || ""} ${row["Last Name"] || ""} (${id}) [${index}]`;
  }

  async function addCadet(row, index) {
    const label = cadetLabel(row, index);
    if (state.selectedCadets.includes(label)) return;
    if (state.selectedCadets.length >= FormFiller.MAX_CADETS) {
      showToast(`Packet limit is ${FormFiller.MAX_CADETS} cadets.`, "error");
      return;
    }
    state.selectedCadets.push(label);
    await persistCadets();
    renderSelected();
  }

  function renderSelected() {
    els.selectedList.innerHTML = "";
    state.selectedCadets.forEach((label, i) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className =
        "w-full text-left px-3 py-2 text-sm border-b border-[var(--line)] hover:bg-[#f7fafc] selected-item";
      option.dataset.index = String(i);
      option.textContent = label;
      option.addEventListener("click", () => {
        els.selectedList
          .querySelectorAll(".selected-item")
          .forEach((el) =>
            el.classList.remove("bg-[#eef5ff]", "ring-1", "ring-[var(--navy-mid)]")
          );
        option.classList.add("bg-[#eef5ff]", "ring-1", "ring-[var(--navy-mid)]");
        option.dataset.selected = "1";
        els.selectedList.querySelectorAll(".selected-item").forEach((el) => {
          if (el !== option) delete el.dataset.selected;
        });
      });
      els.selectedList.appendChild(option);
    });
    els.selectedCount.textContent = String(state.selectedCadets.length);
  }

  async function removeSelectedCadet() {
    const active = els.selectedList.querySelector('[data-selected="1"]');
    if (!active) {
      showToast("Select a cadet in the list to remove.", "error");
      return;
    }
    const idx = Number(active.dataset.index);
    state.selectedCadets.splice(idx, 1);
    await persistCadets();
    renderSelected();
  }

  async function clearList() {
    if (!state.selectedCadets.length) return;
    const ok = window.confirm(
      "Are you sure you want to remove all cadets from the list?\nThis action cannot be undone."
    );
    if (!ok) return;
    state.selectedCadets = [];
    await persistCadets();
    renderSelected();
  }

  async function generateForm() {
    if (!state.rows.length) {
      showToast("Please upload a spreadsheet with cadet data.", "error");
      return;
    }
    if (!state.selectedCadets.length) {
      showToast("Add at least one cadet before generating.", "error");
      return;
    }
    const outputName = els.outputName.value.trim();
    if (!outputName) {
      showToast("Please enter a name for the output PDF file.", "error");
      return;
    }

    const indexList = [];
    for (const item of state.selectedCadets) {
      const match = String(item).match(/\[(\d+)\]$/);
      if (match) indexList.push(Number(match[1]));
    }

    if (!indexList.length) {
      showToast("Could not resolve selected cadet rows. Clear and re-add them.", "error");
      return;
    }

    els.generateBtn.disabled = true;
    const originalLabel = "Generate Form →";

    try {
      await persistOutputName();
      const bytes = await FormFiller.fillForm(state.rows, indexList, (status) => {
        els.generateBtn.textContent = status;
      });
      FormFiller.downloadPdf(bytes, outputName);
      showToast("Packet generated and downloading.", "ok");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Failed to generate PDF.", "error");
    } finally {
      els.generateBtn.disabled = false;
      els.generateBtn.textContent = originalLabel;
    }
  }

  function openModal(show) {
    els.helpModal.classList.toggle("hidden", !show);
    els.helpModal.setAttribute("aria-hidden", show ? "false" : "true");
  }

  function showToast(message, type) {
    els.toast.textContent = message;
    els.toast.classList.remove("hidden", "bg-[var(--ok)]", "bg-[var(--danger)]");
    els.toast.classList.add(type === "error" ? "bg-[var(--danger)]" : "bg-[var(--ok)]");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => els.toast.classList.add("hidden"), 4200);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }
})();
