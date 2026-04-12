export default function resolve(workflow, params, context) {
  const patched = context.defaultResolve(workflow, params, context);

  const mode = params.quality_mode ?? "balanced";

  const latentNode = patched["4"];
  const samplerNode = patched["5"];

  if (!latentNode?.inputs || !samplerNode?.inputs) {
    throw new Error('portrait-balanced expects nodes "4" and "5" to exist');
  }

  if (mode === "fast") {
    latentNode.inputs.width = 768;
    latentNode.inputs.height = 1152;
    samplerNode.inputs.steps = 16;
    samplerNode.inputs.cfg = 5.5;
  } else if (mode === "detail") {
    latentNode.inputs.width = 896;
    latentNode.inputs.height = 1344;
    samplerNode.inputs.steps = 32;
    samplerNode.inputs.cfg = 7.0;
  } else {
    latentNode.inputs.width = 832;
    latentNode.inputs.height = 1216;
    samplerNode.inputs.steps = 24;
    samplerNode.inputs.cfg = 6.5;
  }

  return patched;
}
