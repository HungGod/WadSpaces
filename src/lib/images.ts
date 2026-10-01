// Uploaded images (wallpapers, custom icons) are downscaled in the browser and
// kept inline in the wadspace as data URLs: a phone photo is 5-10 MB, a
// 1920 px JPEG a few hundred KB.

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't an image the app can read."));
    img.src = src;
  });
}

/** Fit inside max×max. Without `type`, PNG keeps transparency (icons) and everything else becomes JPEG. */
async function downscale(file: File, max: number, quality: number, type?: string): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("Pick an image file.");
  const url = URL.createObjectURL(file);
  try {
    const img = await load(url);
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const out = type ?? (file.type === "image/png" || file.type === "image/svg+xml" ? "image/png" : "image/jpeg");
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process the image."))), out, quality),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/**
 * The image downscaled, as a data URL. `maxBytes` caps the data URL itself
 * (online, it goes in a Firestore doc, which holds 1 MiB at most).
 */
export async function imageDataUrl(file: File, o: { max: number; quality: number; type?: string; maxBytes?: number }): Promise<string> {
  const url = await blobToDataUrl(await downscale(file, o.max, o.quality, o.type));
  if (o.maxBytes && url.length > o.maxBytes) {
    const kb = (n: number) => `${Math.round(n / 1024)} KB`;
    throw new Error(`That image is ${kb(url.length)} even after shrinking it; the limit is ${kb(o.maxBytes)}. Try a simpler or smaller image.`);
  }
  return url;
}
