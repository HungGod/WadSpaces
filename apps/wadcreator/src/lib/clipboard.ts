// Copying text. WebKit (the machine app) only lets a page copy straight after
// a click: by the time a slow report is ready, that's over. A ClipboardItem
// made during the click, holding a promise of the text, keeps the right.

export async function copyText(text: string | Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    const blob = Promise.resolve(text).then((t) => new Blob([t], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    return;
  }
  await navigator.clipboard.writeText(await text);
}
