module.exports = {
    dependency: {
        platforms: {
            android: {
                packageInstance:
                    "new CodePush(getApplicationContext(), BuildConfig.DEBUG)"
            }
        }
    }
};
