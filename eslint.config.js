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
    // Сборка, зависимости и объявления типов не проверяются: это не исходники.
    //
    // Каталог с готовой сборкой LibreOffice для браузера перечислен явно,
    // хотя и лежит в .gitignore: ESLint на .gitignore не смотрит. Без этой
    // строки линт разбирает минифицированный код вендора и выдаёт сотни
    // ошибок на нём — то есть свои ошибки в этом шуме уже не видны.
    //
    // Перенесённая обвязка (`public/uno/runtime.js`) исключена по той же
    // причине: это код allotropia под MIT, замечания к нему — не к нашему
    // коду, а правка запрещена (см. шапку файла).
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'apps/web/lowa/assets/**',
      'apps/web/src/local/public/uno/runtime.js',
    ],
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
    // в TypeScript-файлах их подставляет парсер, а в чистый JS — нет.
    // Скрипт получения сборки LOWA сюда же: он тоже исполняется в Node,
    // а не в браузере, и работает с `fetch`, `Buffer` и `process`.
    files: ['tests/**/*.js', '*.config.js', '*.config.ts', 'apps/web/lowa/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  }
);
