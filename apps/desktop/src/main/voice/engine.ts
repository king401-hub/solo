/** Loads the offline speech engine. It ships native code that does not exist for 32-bit Windows, so there it fails with a plain explanation instead of a module error. */
export async function loadTransformers(): Promise<typeof import("@huggingface/transformers")> {
  try {
    return await import("@huggingface/transformers");
  } catch (e) {
    if (process.arch === "ia32") throw new Error("Offline voice recognition is not available on 32-bit Windows. Everything else in Solo works.");
    throw e;
  }
}
