module.exports = function (api) {
  api.cache(true);

  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
          alias: {
            "@": "./src",
            // Listed before "@th/ui" for readability only — module-resolver
            // anchors each alias to an exact segment boundary, so "@th/ui"
            // never swallows "@th/ui-native".
            "@th/ui-native": "../../packages/ui-native/src",
            "@th/ui": "../../packages/ui/src",
          },
        },
      ],
      // react-native-reanimated must be the LAST plugin in the list.
      "react-native-reanimated/plugin",
    ],
  };
};
