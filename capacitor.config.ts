import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.amolpandhare00.sara",
  appName: "SARA",
  webDir: "dist",
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#070b14",
    },
  },
};

export default config;
