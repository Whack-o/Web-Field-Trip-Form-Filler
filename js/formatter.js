/**
 * Address and phone formatting (ported from old_app/logic/formatter.py).
 */
const Formatter = (() => {
  const STATES = new Set([
    "Al", "Ak", "Az", "Ar", "Ca", "Co", "Ct", "De", "Fl", "Ga",
    "Hi", "Id", "Il", "In", "Ia", "Ks", "Ky", "La", "Me", "Md",
    "Ma", "Mi", "Mn", "Ms", "Mo", "Mt", "Ne", "Nv", "Nh", "Nj",
    "Nm", "Ny", "Nc", "Nd", "Oh", "Ok", "Or", "Pa", "Ri", "Sc",
    "Sd", "Tn", "Tx", "Ut", "Vt", "Va", "Wa", "Wv", "Wi", "Wy",
  ]);

  /** Match Python str.title() closely (including apostrophe words). */
  function titleCase(str) {
    return String(str).replace(
      /[A-Za-z]+('[A-Za-z]+)?/g,
      (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    );
  }

  function formatAddress(addr) {
    if (!addr) return "";
    // Python: addr.title() then uppercase 2-letter state tokens
    const titled = titleCase(addr);
    return titled
      .split(/\s+/)
      .map((word) => {
        const clean = word.replace(/,/g, "");
        return STATES.has(clean) ? word.toUpperCase() : word;
      })
      .join(" ");
  }

  function formatPhone(phone) {
    if (!phone) return "";
    // phonenumbers NATIONAL for US 10-digit numbers → (XXX) XXX-XXXX
    const digits = String(phone).replace(/\D/g, "");
    let national = digits;
    if (national.length === 11 && national.startsWith("1")) {
      national = national.slice(1);
    }
    if (national.length === 10) {
      return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
    }
    return String(phone).trim();
  }

  return { formatAddress, formatPhone, titleCase };
})();
