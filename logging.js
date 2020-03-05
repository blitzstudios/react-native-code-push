/* Logs messages to console with the [CodePush] prefix */
function log(message, bundleName) {
  if (bundleName) {
    console.log(`[CodePush] [${bundleName}] ${message}`);
  } else {
    console.log(`[CodePush] ${message}`);
  }
}

module.exports = log;
