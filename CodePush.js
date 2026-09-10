import { AcquisitionManager as Sdk } from "code-push/script/acquisition-sdk";
import { Alert } from "./AlertAdapter";
import requestFetchAdapter from "./request-fetch-adapter";
import { AppState, Platform } from "react-native";
import log from "./logging";
import hoistStatics from 'hoist-non-react-statics';

let NativeCodePush = require("react-native").NativeModules.CodePush;
const PackageMixins = require("./package-mixins")(NativeCodePush);

const UPDATE_CHECK_PATH_REGEX = /\/update_check(?:\?|$)/;
const HTTP_VERB_GET = 0;

/*
 * Rollout membership is otherwise decided server-side by hashing the device id, which makes
 * every answer during a ramp specific to one device and so impossible for a shared cache to
 * hold. Sending the bucket lets the server decide from the request alone, so a CDN can serve
 * the whole fleet from a single origin fetch while a rollout is still ramping.
 *
 * Coarse deliberately: the bucket becomes part of the cache key, so 5% steps multiply the
 * number of cached entries by 20 rather than 100. Going coarser would distort the ramp, since
 * membership is `bucket < rollout` and so rounds up at each step.
 */
const ROLLOUT_BUCKET_GRANULARITY = 5;

/**
 * A 32-bit hash whose low bits depend on every bit of the input. The multiply-and-add loop on
 * its own leaves them dominated by the last few characters, which matters twice over here:
 * client ids are uuids that vary mostly near the front, and reducing the result modulo the
 * bucket count reads nothing but the low bits. Without the final mixing step uuid-shaped ids
 * spread across buckets only half as evenly, and moving to the next label shifted every device
 * by the same amount, rotating the fleet in lockstep rather than reshuffling it.
 */
function getBucketHash(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Stable while a device stays on one release and reshuffled once it moves to the next, so the
 * same users aren't permanently first in every rollout. Salted with the label the device is
 * currently running rather than the one on offer, because that is what it knows at request
 * time. A server that doesn't understand the parameter ignores it and falls back to hashing
 * the device id itself, so sending it is always safe.
 */
function getRolloutBucket(clientUniqueId, currentLabel) {
  if (!clientUniqueId) {
    return null;
  }

  const bucketCount = 100 / ROLLOUT_BUCKET_GRANULARITY;
  const bucket = getBucketHash(`${clientUniqueId}-${currentLabel || ""}`) % bucketCount;
  return bucket * ROLLOUT_BUCKET_GRANULARITY;
}

function withUpdateCheckQueryParameters(httpRequester, queryParameters) {
  if (!queryParameters) {
    return httpRequester;
  }

  const serializedParams = Object.keys(queryParameters)
    .reduce((accumulator, key) => {
      const value = queryParameters[key];
      if (value !== undefined && value !== null) {
        accumulator.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
      return accumulator;
    }, [])
    .join("&");

  if (!serializedParams) {
    return httpRequester;
  }

  return {
    request(verb, url, requestBody, callback) {
      const shouldAppendParams = verb === HTTP_VERB_GET && typeof url === "string" && UPDATE_CHECK_PATH_REGEX.test(url);
      if (!shouldAppendParams) {
        return httpRequester.request(verb, url, requestBody, callback);
      }

      const separator = url.includes("?") ? "&" : "?";
      return httpRequester.request(verb, `${url}${separator}${serializedParams}`, requestBody, callback);
    }
  };
}

async function checkForUpdate(deploymentKey = null, serverUrl = null, handleBinaryVersionMismatchCallback = null, options = {}) {
  /*
   * Before we ask the server if an update exists, we
   * need to retrieve three pieces of information from the
   * native side: deployment key, app version (e.g. 1.0.1)
   * and the hash of the currently running update (if there is one).
   * This allows the client to only receive updates which are targetted
   * for their specific deployment and version and which are actually
   * different from the CodePush update they have already installed.
   */
  const nativeConfig = await getConfiguration();
  /*
   * If a deployment key was explicitly provided,
   * then let's override the one we retrieved
   * from the native-side of the app. This allows
   * dynamically "redirecting" end-users at different
   * deployments (e.g. an early access deployment for insiders).
   */
  const config = {
    ...nativeConfig,
    deploymentKey: deploymentKey || nativeConfig.deploymentKey,
    serverUrl: serverUrl || nativeConfig.serverUrl,
  };

  // Use dynamically overridden getCurrentPackage() during tests.
  const localPackage = await module.exports.getCurrentPackage();

  /*
   * If the app has a previously installed update, and that update
   * was targetted at the same app version that is currently running,
   * then we want to use its package hash to determine whether a new
   * release has been made on the server. Otherwise, we only need
   * to send the app version to the server, since we are interested
   * in any updates for current binary version, regardless of hash.
   */
  let queryPackage;
  if (localPackage) {
    queryPackage = localPackage;
  } else {
    queryPackage = { appVersion: config.appVersion };
    if (Platform.OS === "ios" && config.packageHash) {
      queryPackage.packageHash = config.packageHash;
    }
  }

  // Built after queryPackage because the bucket is salted with the label being reported.
  const rolloutBucket = getRolloutBucket(config.clientUniqueId, queryPackage.label);
  const httpRequester = withUpdateCheckQueryParameters(requestFetchAdapter, {
    ...(options && options.beta ? { beta: true } : null),
    ...(rolloutBucket === null ? null : { rollout_bucket: rolloutBucket }),
  });
  const sdk = getPromisifiedSdk(httpRequester, config);

  const update = await sdk.queryUpdateWithCurrentPackage(queryPackage);

  /*
   * There are four cases where checkForUpdate will resolve to null:
   * ----------------------------------------------------------------
   * 1) The server said there isn't an update. This is the most common case.
   * 2) The server said there is an update but it requires a newer binary version.
   *    This would occur when end-users are running an older binary version than
   *    is available, and CodePush is making sure they don't get an update that
   *    potentially wouldn't be compatible with what they are running.
   * 3) The server said there is an update, but the update's hash is the same as
   *    the currently running update. This should _never_ happen, unless there is a
   *    bug in the server, but we're adding this check just to double-check that the
   *    client app is resilient to a potential issue with the update check.
   * 4) The server said there is an update, but the update's hash is the same as that
   *    of the binary's currently running version. This should only happen in Android -
   *    unlike iOS, we don't attach the binary's hash to the updateCheck request
   *    because we want to avoid having to install diff updates against the binary's
   *    version, which we can't do yet on Android.
   */
  if (!update || update.updateAppVersion ||
      localPackage && (update.packageHash === localPackage.packageHash) ||
      (!localPackage || localPackage._isDebugOnly) && config.packageHash === update.packageHash) {
    if (update && update.updateAppVersion) {
      log("An update is available but it is not targeting the binary version of your app.");
      if (handleBinaryVersionMismatchCallback && typeof handleBinaryVersionMismatchCallback === "function") {
        handleBinaryVersionMismatchCallback(update)
      }
    }

    return null;
  } else {
    const remotePackage = { ...update, ...PackageMixins.remote(sdk.reportStatusDownload) };
    remotePackage.failedInstall = await NativeCodePush.isFailedUpdate(remotePackage.packageHash);
    remotePackage.deploymentKey = deploymentKey || nativeConfig.deploymentKey;
    return remotePackage;
  }
}

const getConfiguration = (() => {
  let config;
  return async function getConfiguration() {
    if (config) {
      return config;
    } else if (testConfig) {
      return testConfig;
    } else {
      config = await NativeCodePush.getConfiguration();
      return config;
    }
  }
})();

async function getCurrentPackage() {
  return getUpdateMetadata(CodePush.UpdateState.LATEST);
}

async function getUpdateMetadata(updateState) {
  let updateMetadata = await NativeCodePush.getUpdateMetadata(updateState || CodePush.UpdateState.RUNNING);
  if (updateMetadata) {
    updateMetadata = {...PackageMixins.local, ...updateMetadata};
    updateMetadata.failedInstall = await NativeCodePush.isFailedUpdate(updateMetadata.packageHash);
    updateMetadata.isFirstRun = await NativeCodePush.isFirstRun(updateMetadata.packageHash);
  }
  return updateMetadata;
}

function getPromisifiedSdk(requestFetchAdapter, config) {
  // Use dynamically overridden AcquisitionSdk during tests.
  const sdk = new module.exports.AcquisitionSdk(requestFetchAdapter, config);
  sdk.queryUpdateWithCurrentPackage = (queryPackage) => {
    return new Promise((resolve, reject) => {
      module.exports.AcquisitionSdk.prototype.queryUpdateWithCurrentPackage.call(sdk, queryPackage, (err, update) => {
        if (err) {
          reject(err);
        } else {
          resolve(update);
        }
      });
    });
  };

  sdk.reportStatusDeploy = (deployedPackage, status, previousLabelOrAppVersion, previousDeploymentKey) => {
    return new Promise((resolve, reject) => {
      module.exports.AcquisitionSdk.prototype.reportStatusDeploy.call(sdk, deployedPackage, status, previousLabelOrAppVersion, previousDeploymentKey, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  };

  sdk.reportStatusDownload = (downloadedPackage) => {
    return new Promise((resolve, reject) => {
      module.exports.AcquisitionSdk.prototype.reportStatusDownload.call(sdk, downloadedPackage, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  };

  return sdk;
}

// This ensures that notifyApplicationReadyInternal is only called once
// in the lifetime of this module instance.
const notifyApplicationReady = (() => {
  let notifyApplicationReadyPromise;
  return (deploymentKey, serverUrl) => {
    if (!notifyApplicationReadyPromise) {
      notifyApplicationReadyPromise = notifyApplicationReadyInternal(deploymentKey, serverUrl);
    }

    return notifyApplicationReadyPromise;
  };
})();

async function notifyApplicationReadyInternal(deploymentKey, serverUrl) {
  await NativeCodePush.notifyApplicationReady();
  const statusReport = await NativeCodePush.getNewStatusReport();
  statusReport && tryReportStatus(statusReport, null, deploymentKey, serverUrl); // Don't wait for this to complete.

  return statusReport;
}

async function tryReportStatus(statusReport, retryOnAppResume, deploymentKey, serverUrl) {
  let config = await getConfiguration();
  
  // Only override config values if they are provided
  if (serverUrl) {
    config.serverUrl = serverUrl;
  }
  
  if (deploymentKey) {
    config.deploymentKey = deploymentKey;
  }
  
  const previousLabelOrAppVersion = statusReport.previousLabelOrAppVersion;
  const previousDeploymentKey = statusReport.previousDeploymentKey || config.deploymentKey;
  try {
    if (statusReport.appVersion) {
      log(`Reporting binary update (${statusReport.appVersion})`);

      if (!config.deploymentKey) {
        throw new Error("Deployment key is missed");
      }

      const sdk = getPromisifiedSdk(requestFetchAdapter, config);
      await sdk.reportStatusDeploy(/* deployedPackage */ null, /* status */ null, previousLabelOrAppVersion, previousDeploymentKey);
    } else {
      const label = statusReport.package.label;
      if (statusReport.status === "DeploymentSucceeded") {
        log(`Reporting CodePush update success (${label})`);
      } else {
        log(`Reporting CodePush update rollback (${label})`);
        await NativeCodePush.setLatestRollbackInfo(statusReport.package.packageHash);
      }

      config.deploymentKey = statusReport.package.deploymentKey;
      const sdk = getPromisifiedSdk(requestFetchAdapter, config);
      await sdk.reportStatusDeploy(statusReport.package, statusReport.status, previousLabelOrAppVersion, previousDeploymentKey);
    }

    NativeCodePush.recordStatusReported(statusReport);
    retryOnAppResume && retryOnAppResume.remove();
  } catch (e) {
    log(`Report status failed: ${JSON.stringify(statusReport)} ${e}`);
    NativeCodePush.saveStatusReportForRetry(statusReport);
    // Try again when the app resumes
    if (!retryOnAppResume) {
      const resumeListener = AppState.addEventListener("change", async (newState) => {
        if (newState !== "active") return;
        const refreshedStatusReport = await NativeCodePush.getNewStatusReport();
        if (refreshedStatusReport) {
          tryReportStatus(refreshedStatusReport, resumeListener, deploymentKey, serverUrl);
        } else {
          resumeListener && resumeListener.remove();
        }
      });
    }
  }
}

async function shouldUpdateBeIgnored(remotePackage, syncOptions) {
  let { rollbackRetryOptions } = syncOptions;

  const isFailedPackage = remotePackage && remotePackage.failedInstall;
  if (!isFailedPackage || !syncOptions.ignoreFailedUpdates) {
    return false;
  }

  if (!rollbackRetryOptions) {
    return true;
  }

  if (typeof rollbackRetryOptions !== "object") {
    rollbackRetryOptions = CodePush.DEFAULT_ROLLBACK_RETRY_OPTIONS;
  } else {
    rollbackRetryOptions = { ...CodePush.DEFAULT_ROLLBACK_RETRY_OPTIONS, ...rollbackRetryOptions };
  }

  if (!validateRollbackRetryOptions(rollbackRetryOptions)) {
    return true;
  }

  const latestRollbackInfo = await NativeCodePush.getLatestRollbackInfo();
  if (!validateLatestRollbackInfo(latestRollbackInfo, remotePackage.packageHash)) {
    log("The latest rollback info is not valid.");
    return true;
  }

  const { delayInHours, maxRetryAttempts } = rollbackRetryOptions;
  const hoursSinceLatestRollback = (Date.now() - latestRollbackInfo.time) / (1000 * 60 * 60);
  if (hoursSinceLatestRollback >= delayInHours && maxRetryAttempts >= latestRollbackInfo.count) {
    log("Previous rollback should be ignored due to rollback retry options.");
    return false;
  }

  return true;
}

function validateLatestRollbackInfo(latestRollbackInfo, packageHash) {
  return latestRollbackInfo &&
    latestRollbackInfo.time &&
    latestRollbackInfo.count &&
    latestRollbackInfo.packageHash &&
    latestRollbackInfo.packageHash === packageHash;
}

function validateRollbackRetryOptions(rollbackRetryOptions) {
  if (typeof rollbackRetryOptions.delayInHours !== "number") {
    log("The 'delayInHours' rollback retry parameter must be a number.");
    return false;
  }

  if (typeof rollbackRetryOptions.maxRetryAttempts !== "number") {
    log("The 'maxRetryAttempts' rollback retry parameter must be a number.");
    return false;
  }

  if (rollbackRetryOptions.maxRetryAttempts < 1) {
    log("The 'maxRetryAttempts' rollback retry parameter cannot be less then 1.");
    return false;
  }

  return true;
}

var testConfig;

// This function is only used for tests. Replaces the default SDK, configuration and native bridge
function setUpTestDependencies(testSdk, providedTestConfig, testNativeBridge) {
  if (testSdk) module.exports.AcquisitionSdk = testSdk;
  if (providedTestConfig) testConfig = providedTestConfig;
  if (testNativeBridge) NativeCodePush = testNativeBridge;
}

async function restartApp(onlyIfUpdateIsPending = false) {
  NativeCodePush.restartApp(onlyIfUpdateIsPending);
}

// This function allows only one syncInternal operation to proceed at any given time.
// Parallel calls to sync() while one is ongoing yields CodePush.SyncStatus.SYNC_IN_PROGRESS.
const sync = (() => {
  let syncInProgress = false;
  const setSyncCompleted = () => { syncInProgress = false; };

  return (options = {}, syncStatusChangeCallback, downloadProgressCallback, handleBinaryVersionMismatchCallback) => {
    let syncStatusCallbackWithTryCatch, downloadProgressCallbackWithTryCatch;
    if (typeof syncStatusChangeCallback === "function") {
      syncStatusCallbackWithTryCatch = (...args) => {
        try {
          syncStatusChangeCallback(...args);
        } catch (error) {
          log(`An error has occurred : ${error.stack}`);
        }
      }
    }

    if (typeof downloadProgressCallback === "function") {
      downloadProgressCallbackWithTryCatch = (...args) => {
        try {
          downloadProgressCallback(...args);
        } catch (error) {
          log(`An error has occurred: ${error.stack}`);
        }
      }
    }

    if (syncInProgress) {
      typeof syncStatusCallbackWithTryCatch === "function"
        ? syncStatusCallbackWithTryCatch(CodePush.SyncStatus.SYNC_IN_PROGRESS)
        : log("Sync already in progress.");
      return Promise.resolve(CodePush.SyncStatus.SYNC_IN_PROGRESS);
    }

    syncInProgress = true;
    const syncPromise = syncInternal(options, syncStatusCallbackWithTryCatch, downloadProgressCallbackWithTryCatch, handleBinaryVersionMismatchCallback);
    syncPromise
      .then(setSyncCompleted)
      .catch(setSyncCompleted);

    return syncPromise;
  };
})();

/*
 * The syncInternal method provides a simple, one-line experience for
 * incorporating the check, download and installation of an update.
 *
 * It simply composes the existing API methods together and adds additional
 * support for respecting mandatory updates, ignoring previously failed
 * releases, and displaying a standard confirmation UI to the end-user
 * when an update is available.
 */
async function syncInternal(options = {}, syncStatusChangeCallback, downloadProgressCallback, handleBinaryVersionMismatchCallback) {
  let resolvedInstallMode;
  const syncOptions = {
    deploymentKey: null,
    serverUrl: null,
    beta: false,
    ignoreFailedUpdates: true,
    rollbackRetryOptions: null,
    installMode: CodePush.InstallMode.ON_NEXT_RESTART,
    mandatoryInstallMode: CodePush.InstallMode.IMMEDIATE,
    minimumBackgroundDuration: 0,
    updateDialog: null,
    ...options
  };

  syncStatusChangeCallback = typeof syncStatusChangeCallback === "function"
    ? syncStatusChangeCallback
    : (syncStatus) => {
        switch(syncStatus) {
          case CodePush.SyncStatus.CHECKING_FOR_UPDATE:
            log("Checking for update.");
            break;
          case CodePush.SyncStatus.AWAITING_USER_ACTION:
            log("Awaiting user action.");
            break;
          case CodePush.SyncStatus.DOWNLOADING_PACKAGE:
            log("Downloading package.");
            break;
          case CodePush.SyncStatus.INSTALLING_UPDATE:
            log("Installing update.");
            break;
          case CodePush.SyncStatus.UP_TO_DATE:
            log("App is up to date.");
            break;
          case CodePush.SyncStatus.UPDATE_IGNORED:
            log("User cancelled the update.");
            break;
          case CodePush.SyncStatus.UPDATE_INSTALLED:
            if (resolvedInstallMode == CodePush.InstallMode.ON_NEXT_RESTART) {
              log("Update is installed and will be run on the next app restart.");
            } else if (resolvedInstallMode == CodePush.InstallMode.ON_NEXT_RESUME) {
              if (syncOptions.minimumBackgroundDuration > 0) {
                log(`Update is installed and will be run after the app has been in the background for at least ${syncOptions.minimumBackgroundDuration} seconds.`);
              } else {
                log("Update is installed and will be run when the app next resumes.");
              }
            }
            break;
          case CodePush.SyncStatus.UNKNOWN_ERROR:
            log("An unknown error occurred.");
            break;
        }
      };

  try {
    await CodePush.notifyApplicationReady(syncOptions.deploymentKey, syncOptions.serverUrl);

    syncStatusChangeCallback(CodePush.SyncStatus.CHECKING_FOR_UPDATE);
    const remotePackage = await checkForUpdate(
      syncOptions.deploymentKey,
      syncOptions.serverUrl,
      handleBinaryVersionMismatchCallback,
      { beta: syncOptions.beta }
    );

    const doDownloadAndInstall = async () => {
      syncStatusChangeCallback(CodePush.SyncStatus.DOWNLOADING_PACKAGE);
      const localPackage = await remotePackage.download(downloadProgressCallback);

      // Determine the correct install mode based on whether the update is mandatory or not.
      resolvedInstallMode = localPackage.isMandatory ? syncOptions.mandatoryInstallMode : syncOptions.installMode;

      syncStatusChangeCallback(CodePush.SyncStatus.INSTALLING_UPDATE);
      await localPackage.install(resolvedInstallMode, syncOptions.minimumBackgroundDuration, () => {
        syncStatusChangeCallback(CodePush.SyncStatus.UPDATE_INSTALLED);
      });

      return CodePush.SyncStatus.UPDATE_INSTALLED;
    };

    const updateShouldBeIgnored = await shouldUpdateBeIgnored(remotePackage, syncOptions);

    if (!remotePackage || updateShouldBeIgnored) {
      if (updateShouldBeIgnored) {
          log("An update is available, but it is being ignored due to having been previously rolled back.");
      }

      const currentPackage = await CodePush.getCurrentPackage();
      if (currentPackage && currentPackage.isPending) {
        syncStatusChangeCallback(CodePush.SyncStatus.UPDATE_INSTALLED);
        return CodePush.SyncStatus.UPDATE_INSTALLED;
      } else {
        syncStatusChangeCallback(CodePush.SyncStatus.UP_TO_DATE);
        return CodePush.SyncStatus.UP_TO_DATE;
      }
    } else if (syncOptions.updateDialog) {
      // updateDialog supports any truthy value (e.g. true, "goo", 12),
      // but we should treat a non-object value as just the default dialog
      if (typeof syncOptions.updateDialog !== "object") {
        syncOptions.updateDialog = CodePush.DEFAULT_UPDATE_DIALOG;
      } else {
        syncOptions.updateDialog = { ...CodePush.DEFAULT_UPDATE_DIALOG, ...syncOptions.updateDialog };
      }

      return await new Promise((resolve, reject) => {
        let message = null;
        let installButtonText = null;

        const dialogButtons = [];

        if (remotePackage.isMandatory) {
          message = syncOptions.updateDialog.mandatoryUpdateMessage;
          installButtonText = syncOptions.updateDialog.mandatoryContinueButtonLabel;
        } else {
          message = syncOptions.updateDialog.optionalUpdateMessage;
          installButtonText = syncOptions.updateDialog.optionalInstallButtonLabel;
          // Since this is an optional update, add a button
          // to allow the end-user to ignore it
          dialogButtons.push({
            text: syncOptions.updateDialog.optionalIgnoreButtonLabel,
            onPress: () => {
              syncStatusChangeCallback(CodePush.SyncStatus.UPDATE_IGNORED);
              resolve(CodePush.SyncStatus.UPDATE_IGNORED);
            }
          });
        }
        
        // Since the install button should be placed to the 
        // right of any other button, add it last
        dialogButtons.push({
          text: installButtonText,
          onPress:() => {
            doDownloadAndInstall()
              .then(resolve, reject);
          }
        })

        // If the update has a description, and the developer
        // explicitly chose to display it, then set that as the message
        if (syncOptions.updateDialog.appendReleaseDescription && remotePackage.description) {
          message += `${syncOptions.updateDialog.descriptionPrefix} ${remotePackage.description}`;
        }

        syncStatusChangeCallback(CodePush.SyncStatus.AWAITING_USER_ACTION);
        Alert.alert(syncOptions.updateDialog.title, message, dialogButtons);
      });
    } else {
      return await doDownloadAndInstall();
    }
  } catch (error) {
    syncStatusChangeCallback(CodePush.SyncStatus.UNKNOWN_ERROR);
    log(error.message);
    throw error;
  }
};

let CodePush;

function codePushify(options = {}) {
  let React;
  let ReactNative = require("react-native");

  try { React = require("react"); } catch (e) { }
  if (!React) {
    try { React = ReactNative.React; } catch (e) { }
    if (!React) {
      throw new Error("Unable to find the 'React' module.");
    }
  }

  if (!React.Component) {
    throw new Error(
`Unable to find the "Component" class, please either:
1. Upgrade to a newer version of React Native that supports it, or
2. Call the codePush.sync API in your component instead of using the @codePush decorator`
    );
  }

  const decorator = (RootComponent) => {
    class CodePushComponent extends React.Component {
      constructor(props) {
        super(props);
        this.rootComponentRef = React.createRef();
      }

      componentDidMount() {
        if (options.checkFrequency !== CodePush.CheckFrequency.MANUAL) {
          const rootComponentInstance = this.rootComponentRef.current;

          let syncStatusCallback;
          if (rootComponentInstance && rootComponentInstance.codePushStatusDidChange) {
            syncStatusCallback = rootComponentInstance.codePushStatusDidChange.bind(rootComponentInstance);
          }

          let downloadProgressCallback;
          if (rootComponentInstance && rootComponentInstance.codePushDownloadDidProgress) {
            downloadProgressCallback = rootComponentInstance.codePushDownloadDidProgress.bind(rootComponentInstance);
          }

          let handleBinaryVersionMismatchCallback;
          if (rootComponentInstance && rootComponentInstance.codePushOnBinaryVersionMismatch) {
            handleBinaryVersionMismatchCallback = rootComponentInstance.codePushOnBinaryVersionMismatch.bind(rootComponentInstance);
          }

          CodePush.sync(options, syncStatusCallback, downloadProgressCallback, handleBinaryVersionMismatchCallback);

          if (options.checkFrequency === CodePush.CheckFrequency.ON_APP_RESUME) {
            ReactNative.AppState.addEventListener("change", (newState) => {
              if (newState === "active") {
                CodePush.sync(options, syncStatusCallback, downloadProgressCallback);
              }
            });
          }
        }
      }

      render() {
        const props = {...this.props};

        // We can set ref property on class components only (not stateless)
        // Check it by render method
        if (RootComponent.prototype && RootComponent.prototype.render) {
          props.ref = this.rootComponentRef;
        }

        return <RootComponent {...props} />
      }
    }

    return hoistStatics(CodePushComponent, RootComponent);
  }

  if (typeof options === "function") {
    // Infer that the root component was directly passed to us.
    return decorator(options);
  } else {
    return decorator;
  }
}

// If the "NativeCodePush" variable isn't defined, then
// the app didn't properly install the native module,
// and therefore, it doesn't make sense initializing
// the JS interface when it wouldn't work anyways.
if (NativeCodePush) {
  CodePush = codePushify;
  Object.assign(CodePush, {
    AcquisitionSdk: Sdk,
    checkForUpdate,
    getConfiguration,
    getCurrentPackage,
    getUpdateMetadata,
    log,
    notifyAppReady: notifyApplicationReady,
    notifyApplicationReady,
    restartApp,
    setUpTestDependencies,
    sync,
    disallowRestart: NativeCodePush.disallow,
    allowRestart: NativeCodePush.allow,
    clearUpdates: NativeCodePush.clearUpdates,
    InstallMode: {
      IMMEDIATE: NativeCodePush.codePushInstallModeImmediate, // Restart the app immediately
      ON_NEXT_RESTART: NativeCodePush.codePushInstallModeOnNextRestart, // Don't artificially restart the app. Allow the update to be "picked up" on the next app restart
      ON_NEXT_RESUME: NativeCodePush.codePushInstallModeOnNextResume, // Restart the app the next time it is resumed from the background
      ON_NEXT_SUSPEND: NativeCodePush.codePushInstallModeOnNextSuspend // Restart the app _while_ it is in the background,
      // but only after it has been in the background for "minimumBackgroundDuration" seconds (0 by default),
      // so that user context isn't lost unless the app suspension is long enough to not matter
    },
    SyncStatus: {
      UP_TO_DATE: 0, // The running app is up-to-date
      UPDATE_INSTALLED: 1, // The app had an optional/mandatory update that was successfully downloaded and is about to be installed.
      UPDATE_IGNORED: 2, // The app had an optional update and the end-user chose to ignore it
      UNKNOWN_ERROR: 3,
      SYNC_IN_PROGRESS: 4, // There is an ongoing "sync" operation in progress.
      CHECKING_FOR_UPDATE: 5,
      AWAITING_USER_ACTION: 6,
      DOWNLOADING_PACKAGE: 7,
      INSTALLING_UPDATE: 8
    },
    CheckFrequency: {
      ON_APP_START: 0,
      ON_APP_RESUME: 1,
      MANUAL: 2
    },
    UpdateState: {
      RUNNING: NativeCodePush.codePushUpdateStateRunning,
      PENDING: NativeCodePush.codePushUpdateStatePending,
      LATEST: NativeCodePush.codePushUpdateStateLatest
    },
    DeploymentStatus: {
      FAILED: "DeploymentFailed",
      SUCCEEDED: "DeploymentSucceeded",
    },
    DEFAULT_UPDATE_DIALOG: {
      appendReleaseDescription: false,
      descriptionPrefix: " Description: ",
      mandatoryContinueButtonLabel: "Continue",
      mandatoryUpdateMessage: "An update is available that must be installed.",
      optionalIgnoreButtonLabel: "Ignore",
      optionalInstallButtonLabel: "Install",
      optionalUpdateMessage: "An update is available. Would you like to install it?",
      title: "Update available"
    },
    DEFAULT_ROLLBACK_RETRY_OPTIONS: {
      delayInHours: 24,
      maxRetryAttempts: 1
    }
  });
} else {
  log("The CodePush module doesn't appear to be properly installed. Please double-check that everything is setup correctly.");
}

module.exports = CodePush;
