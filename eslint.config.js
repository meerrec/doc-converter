/**
 * Конфигурация ESLint.
 *
 * Линтер появился ради правил `react-hooks`: в вебе есть подавление
 * `react-hooks/exhaustive-deps`, которое до этого ничего не глушило —
 * ESLint не был установлен вовсе. Комментарий-заглушка создавал видимость
 * проверки зависимостей эффектов, которой не происходило.
 *
 * Наборы правил взяты рекомендованные и без донастроек: своя подборка
 * разошлась бы с обновлениями плагинов, а цель — не стиль, а ошибки.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    // Сборка, зависимости и объявления типов не проверяются: это не исходники
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    // Правила хуков применяются только к React-приложению: в воркере
    // и автоскейлере React нет
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },

  {
    // Тесты и конфиги исполняются в Node, поэтому им нужны его глобали:
    // в TypeScript-файлах их подставляет парсер, а в чистый JS — нет
    files: ['tests/**/*.js', '*.config.js', '*.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  }
);
