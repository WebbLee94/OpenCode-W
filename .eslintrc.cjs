module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  // `src-tauri/target` 是 cargo 的构建产物目录（gitignored），里面有 tauri-codegen
  // 生成的 `.js`，eslint 会把它们当源码解析并报 Parsing error。CI 里 lint 排在
  // cargo build 之前所以不会触发，但本地只要跑过一次 cargo 就会失败 —— 必须排除。
  ignorePatterns: ['dist', '.eslintrc.cjs', 'src-tauri/target'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': 'off',
    'react-hooks/exhaustive-deps': 'warn',
  },
}
