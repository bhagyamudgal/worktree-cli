import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strict,
    {
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/consistent-type-imports": [
                "error",
                { prefer: "type-imports" },
            ],
            "@typescript-eslint/no-non-null-assertion": "error",
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/prefer-as-const": "error",
            "no-console": "off",
        },
    },
    {
        ignores: ["dist/", "node_modules/"],
    }
);
