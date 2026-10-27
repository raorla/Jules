/** Moyenne des valeurs. */
export function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Arrondi au plus proche, à `decimals` chiffres après la virgule. */
export function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
