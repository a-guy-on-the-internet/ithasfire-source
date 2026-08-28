function shouldSkipTrpcDist(filePath) {
  if (typeof filePath !== "string") {
    return false;
  }

  const normalizedPath = filePath.replace(/\\/g, "/");
  return normalizedPath.includes("/@trpc/react-query/dist/") || normalizedPath.includes("/@trpc/client/dist/");
}

module.exports = function (api) {
  const envName = api.env();
  const isDev = envName === "development";

  const tamaguiPlugin = [
    "@tamagui/babel-plugin",
    {
      components: ["@th/ui", "tamagui"],
      config: "./tamagui.config.ts",
      disableExtraction: isDev,
    },
  ];

  const basePresets = [["next/babel", { "preset-env": { modules: false } }]];
  const basePlugins = [tamaguiPlugin, "react-native-reanimated/plugin"];

  return {
    overrides: [
      {
        test: shouldSkipTrpcDist,
        presets: [],
        plugins: [],
        sourceType: "module",
      },
      {
        exclude: shouldSkipTrpcDist,
        presets: basePresets,
        plugins: basePlugins,
      },
    ],
  };
};
