export function kv(label, val, cls) {
  return `<div class="kv"><span>${label}</span><b class="num ${cls || ""}">${val}</b></div>`;
}
