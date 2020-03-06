package com.microsoft.codepush.react;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Resources;

import com.facebook.react.ReactInstanceManager;
import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.JavaScriptModule;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.devsupport.DevInternalSettings;
import com.facebook.react.devsupport.interfaces.DevSupportManager;
import com.facebook.react.uimanager.ViewManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class CodePush implements ReactPackage {

    private static boolean sIsRunningBinaryVersion = false;
    private static boolean sNeedToReportRollback = false;
    private static boolean sTestConfigurationFlag = false;
    private static String sAppVersion = null;

    private boolean mDidUpdate = false;

    // Config properties.
    private static String mServerUrl = "https://codepush.appcenter.ms/";

    private static Context mContext;
    private static ReactInstanceHolder mReactInstanceHolder;
    private static CodePush mCodePushInstance;

    private static String mPublicKey;

    private static Map<String, Object> mModuleInstances = new HashMap<>();

    public static String getServiceUrl() {
        return mServerUrl;
    }

    public CodePush(Context context, String serverUrl) {
        mContext = context.getApplicationContext();
        mServerUrl = serverUrl;
        if (sAppVersion == null) {
            try {
                PackageInfo pInfo = mContext.getPackageManager().getPackageInfo(mContext.getPackageName(), 0);
                sAppVersion = pInfo.versionName;
            } catch (PackageManager.NameNotFoundException e) {
                throw new CodePushUnknownException("Unable to get package info for " + mContext.getPackageName(), e);
            }
        }

        String publicKeyFromStrings = getCustomPropertyFromStringsIfExist("PublicKey");
        if (publicKeyFromStrings != null) mPublicKey = publicKeyFromStrings;

        mCodePushInstance = this;
    }

    public static void initializeModule(String resourceName) {
        ModuleInstance moduleInstance = new ModuleInstance();

        moduleInstance.updateManager = new CodePushUpdateManager(mContext.getFilesDir().getAbsolutePath(), resourceName);
        moduleInstance.telemetryManager = new CodePushTelemetryManager(mContext, resourceName);
        moduleInstance.settingsManager = new SettingsManager(mContext);

        mModuleInstances.put(resourceName, moduleInstance);

        mCodePushInstance.initializeUpdateAfterRestart(resourceName);
    }

    private String getPublicKeyByResourceDescriptor(int publicKeyResourceDescriptor){
        String publicKey;
        try {
            publicKey = mContext.getString(publicKeyResourceDescriptor);
        } catch (Resources.NotFoundException e) {
            throw new CodePushInvalidPublicKeyException(
                    "Unable to get public key, related resource descriptor " +
                            publicKeyResourceDescriptor +
                            " can not be found", e
            );
        }

        if (publicKey.isEmpty()) {
            throw new CodePushInvalidPublicKeyException("Specified public key is empty");
        }
        return publicKey;
    }

    private String getCustomPropertyFromStringsIfExist(String propertyName) {
        String property;

        String packageName = mContext.getPackageName();
        int resId = mContext.getResources().getIdentifier("CodePush" + propertyName, "string", packageName);

        if (resId != 0) {
            property = mContext.getString(resId);

            if (!property.isEmpty()) {
                return property;
            } else {
                CodePushUtils.log("Specified " + propertyName + " is empty");
            }
        }

        return null;
    }

    public void clearDebugCacheIfNeeded(ReactInstanceManager instanceManager, String resourceName) {
        ModuleInstance moduleInstance = getModuleInstance(resourceName);
        boolean isLiveReloadEnabled = false;

        // Use instanceManager for checking if we use LiveReload mode. In this case we should not remove ReactNativeDevBundle.js file
        // because we get error with trying to get this after reloading. Issue: https://github.com/Microsoft/react-native-code-push/issues/1272
        if (instanceManager != null) {
            DevSupportManager devSupportManager = instanceManager.getDevSupportManager();
            if (devSupportManager != null) {
                DevInternalSettings devInternalSettings = (DevInternalSettings)devSupportManager.getDevSettings();
                isLiveReloadEnabled = devInternalSettings.isReloadOnJSChangeEnabled();
            }
        }

        if (moduleInstance.settingsManager.isPendingUpdate(null) && !isLiveReloadEnabled) {
            // This needs to be kept in sync with https://github.com/facebook/react-native/blob/master/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManager.java#L78
            File cachedDevBundle = new File(mContext.getFilesDir(), "ReactNativeDevBundle.js");
            if (cachedDevBundle.exists()) {
                cachedDevBundle.delete();
            }
        }
    }

    public boolean didUpdate() {
        return mDidUpdate;
    }

    public String getAppVersion() {
        return sAppVersion;
    }

    public String getPublicKey() {
        return mPublicKey;
    }

    long getBinaryResourcesModifiedTime() {
        try {
            String packageName = this.mContext.getPackageName();
            int codePushApkBuildTimeId = this.mContext.getResources().getIdentifier(CodePushConstants.CODE_PUSH_APK_BUILD_TIME_KEY, "string", packageName);
            // replace double quotes needed for correct restoration of long value from strings.xml
            // https://github.com/Microsoft/cordova-plugin-code-push/issues/264
            String codePushApkBuildTime = this.mContext.getResources().getString(codePushApkBuildTimeId).replaceAll("\"","");
            return Long.parseLong(codePushApkBuildTime);
        } catch (Exception e) {
            throw new CodePushUnknownException("Error in getting binary resources modified time", e);
        }
    }

    public String getPackageFolder(String resourceName) {
        ModuleInstance moduleInstance = getModuleInstance(resourceName);
        JSONObject codePushLocalPackage = moduleInstance.updateManager.getCurrentPackage();
        if (codePushLocalPackage == null) {
            return null;
        }
        return moduleInstance.updateManager.getPackageFolderPath(codePushLocalPackage.optString("packageHash"));
    }

    @Deprecated
    public static String getBundleUrl(String resourceName) {
        return getJSBundleFile(resourceName);
    }

    public Context getContext() {
        return mContext;
    }

    public ModuleInstance getModuleInstance(String resourceName) {
        return (ModuleInstance) mModuleInstances.get(resourceName);
    }

    public static String getBundleName(String resourceName) {
        return resourceName + ".bundle";
    }

    public static String getJSBundleFile(String resourceName) {
        if (mCodePushInstance == null) {
            throw new CodePushNotInitializedException("A CodePush instance has not been created yet. Have you added it to your app's list of ReactPackages?");
        }

        return mCodePushInstance.getJSBundleFileInternal(resourceName);
    }

    public String getJSBundleFileInternal(String resourceName) {
        ModuleInstance moduleInstance = getModuleInstance(resourceName);
        String binaryJsBundleUrl = CodePushConstants.ASSETS_BUNDLE_PREFIX + getBundleName(resourceName);

        String packageFilePath = null;
        try {
            packageFilePath = moduleInstance.updateManager.getCurrentPackageBundlePath(getBundleName(resourceName));
        } catch (CodePushMalformedDataException e) {
            // We need to recover the app in case 'codepush.json' is corrupted
            CodePushUtils.log(e.getMessage(), resourceName);
            clearUpdates(resourceName);
        }

        if (packageFilePath == null) {
            // There has not been any downloaded updates.
            CodePushUtils.logBundleUrl(binaryJsBundleUrl, resourceName);
            sIsRunningBinaryVersion = true;
            return binaryJsBundleUrl;
        }

        JSONObject packageMetadata = moduleInstance.updateManager.getCurrentPackage();
        if (isPackageBundleLatest(packageMetadata)) {
            CodePushUtils.logBundleUrl(packageFilePath, resourceName);
            sIsRunningBinaryVersion = false;
            return packageFilePath;
        } else {
            // The binary version is newer.
            this.mDidUpdate = false;
            if (hasBinaryVersionChanged(packageMetadata)) {
                this.clearUpdates(resourceName);
            }

            CodePushUtils.logBundleUrl(binaryJsBundleUrl, resourceName);
            sIsRunningBinaryVersion = true;
            return binaryJsBundleUrl;
        }
    }

    public String getServerUrl() {
        return mServerUrl;
    }

    void initializeUpdateAfterRestart(String resourceName) {
        ModuleInstance moduleInstance = getModuleInstance(resourceName);
        // Reset the state which indicates that
        // the app was just freshly updated.
        mDidUpdate = false;
        JSONObject pendingUpdate = moduleInstance.settingsManager.getPendingUpdate();
        if (pendingUpdate != null) {
            JSONObject packageMetadata = moduleInstance.updateManager.getCurrentPackage();
            if (packageMetadata == null || !isPackageBundleLatest(packageMetadata) && hasBinaryVersionChanged(packageMetadata)) {
                CodePushUtils.log("Skipping initializeUpdateAfterRestart(), binary version is newer", resourceName);
                return;
            }

            try {
                boolean updateIsLoading = pendingUpdate.getBoolean(CodePushConstants.PENDING_UPDATE_IS_LOADING_KEY);
                if (updateIsLoading) {
                    // Pending update was initialized, but notifyApplicationReady was not called.
                    // Therefore, deduce that it is a broken update and rollback.
                    CodePushUtils.log("Update did not finish loading the last time, rolling back to a previous version.", resourceName);
                    sNeedToReportRollback = true;
                    rollbackPackage(moduleInstance);
                } else {
                    // There is in fact a new update running for the first
                    // time, so update the local state to ensure the client knows.
                    mDidUpdate = true;

                    // Mark that we tried to initialize the new update, so that if it crashes,
                    // we will know that we need to rollback when the app next starts.
                    moduleInstance.settingsManager.savePendingUpdate(pendingUpdate.getString(CodePushConstants.PENDING_UPDATE_HASH_KEY),
                            /* isLoading */true);
                }
            } catch (JSONException e) {
                // Should not happen.
                throw new CodePushUnknownException("Unable to read pending update metadata stored in SharedPreferences", e);
            }
        }
    }

    void invalidateCurrentInstance() {
        mCodePushInstance = null;
    }

    boolean isDebugMode() {
        return false;
    }

    boolean isRunningBinaryVersion() {
        return sIsRunningBinaryVersion;
    }

    private boolean isPackageBundleLatest(JSONObject packageMetadata) {
        try {
            Long binaryModifiedDateDuringPackageInstall = null;
            String binaryModifiedDateDuringPackageInstallString = packageMetadata.optString(CodePushConstants.BINARY_MODIFIED_TIME_KEY, null);
            if (binaryModifiedDateDuringPackageInstallString != null) {
                binaryModifiedDateDuringPackageInstall = Long.parseLong(binaryModifiedDateDuringPackageInstallString);
            }
            String packageAppVersion = packageMetadata.optString("appVersion", null);
            long binaryResourcesModifiedTime = this.getBinaryResourcesModifiedTime();
            return binaryModifiedDateDuringPackageInstall != null &&
                    binaryModifiedDateDuringPackageInstall == binaryResourcesModifiedTime &&
                    (isUsingTestConfiguration() || sAppVersion.equals(packageAppVersion));
        } catch (NumberFormatException e) {
            throw new CodePushUnknownException("Error in reading binary modified date from package metadata", e);
        }
    }

    private boolean hasBinaryVersionChanged(JSONObject packageMetadata) {
        String packageAppVersion = packageMetadata.optString("appVersion", null);
        return !sAppVersion.equals(packageAppVersion);
    }

    boolean needToReportRollback() {
        return sNeedToReportRollback;
    }

    public static void overrideAppVersion(String appVersionOverride) {
        sAppVersion = appVersionOverride;
    }

    private void rollbackPackage(ModuleInstance moduleInstance) {
        JSONObject failedPackage = moduleInstance.updateManager.getCurrentPackage();
        moduleInstance.settingsManager.saveFailedUpdate(failedPackage);
        moduleInstance.updateManager.rollbackPackage();
        moduleInstance.settingsManager.removePendingUpdate();
    }

    public void setNeedToReportRollback(boolean needToReportRollback) {
        CodePush.sNeedToReportRollback = needToReportRollback;
    }

    /* The below 3 methods are used for running tests.*/
    public static boolean isUsingTestConfiguration() {
        return sTestConfigurationFlag;
    }

    public static void setUsingTestConfiguration(boolean shouldUseTestConfiguration) {
        sTestConfigurationFlag = shouldUseTestConfiguration;
    }

    public void clearUpdates(String resourceName) {
        ModuleInstance moduleInstance = getModuleInstance(resourceName);
        moduleInstance.updateManager.clearUpdates();
        moduleInstance.settingsManager.removePendingUpdate();
        moduleInstance.settingsManager.removeFailedUpdates();
    }

    public static void setReactInstanceHolder(ReactInstanceHolder reactInstanceHolder) {
        mReactInstanceHolder = reactInstanceHolder;
    }

    static ReactInstanceManager getReactInstanceManager() {
        if (mReactInstanceHolder == null) {
            return null;
        }
        return mReactInstanceHolder.getReactInstanceManager();
    }

    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext reactApplicationContext) {
        CodePushNativeModule codePushModule = new CodePushNativeModule(reactApplicationContext, this);
        CodePushDialog dialogModule = new CodePushDialog(reactApplicationContext);

        List<NativeModule> nativeModules = new ArrayList<>();
        nativeModules.add(codePushModule);
        nativeModules.add(dialogModule);
        return nativeModules;
    }

    // Deprecated in RN v0.47.
    public List<Class<? extends JavaScriptModule>> createJSModules() {
        return new ArrayList<>();
    }

    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactApplicationContext) {
        return new ArrayList<>();
    }
}
