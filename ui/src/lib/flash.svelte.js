export const flash = $state({ message: "" });

let timer = null;

export function showFlash(message) {
  flash.message = message;
  clearTimeout(timer);
  timer = setTimeout(() => (flash.message = ""), 6000);
}

export function dismissFlash() {
  flash.message = "";
  clearTimeout(timer);
}
