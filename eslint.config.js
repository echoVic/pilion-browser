import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, { files:['**/*.{ts,tsx}'], plugins:{'react-hooks':hooks}, rules:{...hooks.configs.recommended.rules} }, { ignores:['dist','dist-renderer','node_modules'] });
