/**
 * PDF fill via Pyodide + pypdf — same pipeline as old_app/logic/form_filler.py.
 *
 *   reader = PdfReader(...)
 *   writer.clone_reader_document_root(reader)
 *   writer.set_need_appearances_writer()
 *   writer.update_page_form_field_values(..., auto_regenerate=True)
 *
 * Desktop Python has the `cryptography` package for this PDF's AES encryption.
 * We install the same dependency in Pyodide. The shipped template is also
 * pre-decrypted under a cache-busted filename so Chrome cannot reuse an old
 * encrypted response.
 */
const FormFiller = (() => {
  // New filename + version query: forces browsers to drop cached encrypted PDF
  const TEMPLATE_URL = "forms/field-trip-packet.pdf?v=3";
  const MAX_CADETS = 40;
  const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/";

  let enginePromise = null;

  function prefetch() {
    return getEngine();
  }

  function getEngine() {
    if (!enginePromise) {
      enginePromise = loadEngine().catch((err) => {
        enginePromise = null;
        throw err;
      });
    }
    return enginePromise;
  }

  async function loadEngine() {
    if (typeof loadPyodide !== "function") {
      throw new Error("Pyodide failed to load. Check your network connection.");
    }

    const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX });

    // cryptography is a Pyodide built-in wasm wheel (same role as old_app venv)
    await pyodide.loadPackage(["cryptography"]);

    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");
    await micropip.install(["pypdf", "phonenumbers"]);

    // Exact ports of old_app/logic/formatter.py + form_filler.py
    await pyodide.runPythonAsync(`
import json
import phonenumbers
from pypdf import PdfReader, PdfWriter

def format_address(addr):
    addr = addr.title()
    states = ["Al", "Ak", "Az", "Ar", "Ca", "Co", "Ct", "De", "Fl", "Ga",
            "Hi", "Id", "Il", "In", "Ia", "Ks", "Ky", "La", "Me", "Md",
            "Ma", "Mi", "Mn", "Ms", "Mo", "Mt", "Ne", "Nv", "Nh", "Nj",
            "Nm", "Ny", "Nc", "Nd", "Oh", "Ok", "Or", "Pa", "Ri", "Sc",
            "Sd", "Tn", "Tx", "Ut", "Vt", "Va", "Wa", "Wv", "Wi", "Wy"]
    words = addr.split()
    fixed_words = []
    for word in words:
        clean_word = word.strip(",")
        if clean_word in states:
            fixed_words.append(word.upper())
        else:
            fixed_words.append(word)
    return " ".join(fixed_words)

def format_phone(phone):
    if phone == "":
        return ""
    parsed_num = phonenumbers.parse(phone, "US")
    formatted = phonenumbers.format_number(
        parsed_num, phonenumbers.PhoneNumberFormat.NATIONAL
    )
    return formatted

def fillForm(pdf_template_path, output_path, rows, indexList):
    reader = PdfReader(pdf_template_path)
    # old_app opens the (AES) packet with cryptography available; handle both
    if reader.is_encrypted:
        reader.decrypt("")

    writer = PdfWriter()

    # This copies the entire internal structure including the AcroForm dictionary
    writer.clone_reader_document_root(reader)

    fields = {}
    i = 0  # For telling which number input to edit
    for index in indexList:
        info = rows[index]
        if info is not None:
            i += 1
            fields[f"Student{i}"] = f"{info['First Name']} {info['Last Name']}".title()
            fields[f"ID{i}"] = info["Student ID"]
            fields[f"Grade{i}"] = info["Grade"]
            fields[f"StudentAddress{i}"] = format_address(info["Address"])
            fields[f"Tel#{i}"] = format_phone(info["Phone Number"])

    # pypdf 3.0+ uses this to ensure fields are flagged for rendering
    writer.set_need_appearances_writer()

    for page in writer.pages:
        writer.update_page_form_field_values(
            page,
            fields,
            auto_regenerate=True  # This is the "Fix" for disappearing fields
        )

    with open(output_path, "wb") as f:
        writer.write(f)
`);

    return pyodide;
  }

  async function fillForm(rows, indexList, onStatus) {
    if (indexList.length > MAX_CADETS) {
      throw new Error(
        `This packet supports at most ${MAX_CADETS} cadets. You selected ${indexList.length}.`
      );
    }
    if (!indexList.length) {
      throw new Error("Add at least one cadet before generating.");
    }

    if (onStatus) onStatus("Loading PDF engine…");
    const pyodide = await getEngine();

    if (onStatus) onStatus("Loading form template…");
    const response = await fetch(TEMPLATE_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        "Could not load forms/field-trip-packet.pdf. Hard-refresh the page and try again."
      );
    }
    const templateBytes = new Uint8Array(await response.arrayBuffer());
    if (templateBytes.byteLength < 1000) {
      throw new Error("PDF template download looked empty or corrupt.");
    }
    pyodide.FS.writeFile("/tmp/template.pdf", templateBytes);

    // dtype=str / keep_default_na=False equivalent
    const normalizedRows = rows.map((row) => {
      const out = {};
      Object.keys(row || {}).forEach((k) => {
        out[k] = row[k] == null ? "" : String(row[k]);
      });
      ["First Name", "Last Name", "Student ID", "Grade", "Address", "Phone Number"].forEach(
        (k) => {
          if (!(k in out)) out[k] = "";
        }
      );
      return out;
    });

    if (onStatus) onStatus("Filling participant fields…");
    pyodide.globals.set("rows_json", JSON.stringify(normalizedRows));
    pyodide.globals.set("index_list_json", JSON.stringify(indexList));

    await pyodide.runPythonAsync(`
rows = json.loads(rows_json)
indexList = json.loads(index_list_json)
fillForm("/tmp/template.pdf", "/tmp/filled.pdf", rows, indexList)
`);

    const out = pyodide.FS.readFile("/tmp/filled.pdf");
    try {
      pyodide.FS.unlink("/tmp/template.pdf");
      pyodide.FS.unlink("/tmp/filled.pdf");
    } catch (_) {
      /* ignore */
    }
    return out;
  }

  function downloadPdf(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return { fillForm, downloadPdf, prefetch, MAX_CADETS };
})();
