module.exports = {
    dependency: {
        platforms: {
            android: {
                packageInstance:
                    "new CodePush(getApplicationContext(), getResources().getString(R.string.CodePushServerURL))"
            }
        }
    }
};
