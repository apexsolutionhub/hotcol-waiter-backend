/** Café "today" uses Ethiopia local time — matches hotcol-user cashier / kitchen. */
export const CAFE_BUSINESS_TIMEZONE = "Africa/Addis_Ababa";

export function cafeBusinessDateYmd(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAFE_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function isSameCafeBusinessDay(dateInput, ref = new Date()) {
  const a = cafeBusinessDateYmd(dateInput);
  const b = cafeBusinessDateYmd(ref);
  return a !== "" && a === b;
}
