const path = require("path");
const fs = require("fs");
const pkg = require("./package.json");

module.exports = {
  entry: `./src/${pkg.entry}.jsx`,
  externals: {
    "@builder.io/react": "@builder.io/react",
    "@builder.io/app-context": "@builder.io/app-context",
    "@emotion/core": "@emotion/core",
    react: "react",
    "react-dom": "react-dom",
  },
  output: {
    filename: pkg.output,
    path: path.resolve(__dirname, "dist"),
    libraryTarget: "system",
    clean: true,
  },
  resolve: {
    extensions: [".js", ".jsx"],
  },
  plugins: [{
    apply(compiler) {
      compiler.hooks.thisCompilation.tap('AntomSkillAssets', (compilation) => {
        compilation.hooks.processAssets.tap({
          name: 'AntomSkillAssets',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        }, () => {
          const generated = path.join(__dirname, '.generated');
          const bundle = fs.readFileSync(path.join(generated, 'skill-bundle.json'));
          compilation.emitAsset('skill-bundle.json', new compiler.webpack.sources.RawSource(bundle));
          const downloads = JSON.parse(fs.readFileSync(path.join(generated, 'skill-downloads.json'), 'utf8'));
          for (const [selection, archive] of Object.entries(downloads)) {
            compilation.emitAsset(`antom-skills-${selection.replace(',', '-')}.zip`,
              new compiler.webpack.sources.RawSource(Buffer.from(archive, 'base64')));
          }
        });
      });
    },
  }],
  module: {
    rules: [
      {
        test: /\.(jsx)$/,
        exclude: /node_modules/,
        use: [
          {
            loader: "babel-loader",
          },
        ],
      },
      {
        test: /\.md$/,
        resourceQuery: /raw/,
        type: "asset/source",
      },
    ],
  },
  devServer: {
    port: 1268,
    client: {
      overlay: false,
    },
    static: {
      directory: path.join(__dirname, "./dist"),
    },
    headers: {
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Allow-Origin": "*",
    },
  },
};
