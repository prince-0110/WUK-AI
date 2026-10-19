const expoConfig = require('eslint-config-expo/flat');
const { defineConfig } = require('eslint/config');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  { files: ['backend/**/*.js'], languageOptions: { globals: globals.node } }
]);
