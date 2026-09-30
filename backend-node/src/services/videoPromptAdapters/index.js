const minimaxH3 = require('./minimaxH3');
const passthrough = (intent, prompt) => prompt || intent.original_prompt;
const adapters = { minimaxH3, seedance: require('./seedance'), kling: require('./kling') };
function cloudPrompt(model, intent, prompt) {
  const adapter = [adapters.seedance, adapters.kling].find(a=>a.supports(model));
  return adapter ? adapter.adapt(intent, prompt) : passthrough(intent, prompt);
}
module.exports = { adapters, cloudPrompt };
