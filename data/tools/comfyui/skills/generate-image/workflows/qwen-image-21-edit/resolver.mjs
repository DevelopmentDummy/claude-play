export default function resolve(workflow, params, context) {
  const patched = context.defaultResolve(workflow, params, context);
  let imageIndex = 2;
  for (let i = 1; i <= 9; i++) {
    const key = i === 1 ? "reference_image" : "reference_image_" + i;
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !value.trim()) throw new Error(key + " must be a non-empty image path");
    const id = String(100 + i);
    patched[id] = { class_type: "LoadImage", inputs: { image: value.trim() } };
    patched["4"].inputs["images.image_" + imageIndex] = [id, 0];
    imageIndex++;
  }
  return patched;
}
