/**
 * Проверки правил автомасштабирования.
 *
 * Расчёт отделён от обращения к Docker и Redis (`computeDesiredReplicas` —
 * чистая функция), поэтому проверяется без поднятия инфраструктуры.
 * Ошибка в этих правилах стоит дорого: слишком агрессивное масштабирование
 * съедает память хоста, слишком робкое — копит очередь.
 *
 * Здесь же — разбор пути к сокету движка. Проверяется только то, что можно
 * проверить без движка: сам сокет, его монтирование и политику SELinux
 * тест не покрывает, это предмет прогона на живой машине
 * (docs/deployment.md, раздел «Podman»).
 */

import { describe, it, expect } from 'vitest';

const { computeDesiredReplicas, limitStep, canScaleDown } = await import(
  '../apps/autoscaler/src/autoscaler.js'
);

const { SCALING_PROFILES, resolveDockerSocketPath } = await import(
  '../packages/config/src/index.js'
);

describe('Автомасштабирование: расчёт числа реплик', () => {
  it('пустая очередь опускает лёгкие воркеры до минимума', () => {
    const desired = computeDesiredReplicas('light', {
      waiting: 0,
      active: 0,
      currentReplicas: 3,
    });

    expect(desired).toBe(SCALING_PROFILES.light.min);
  });

  it('тяжёлая очередь не опускается ниже одной реплики', () => {
    const desired = computeDesiredReplicas('heavy', {
      waiting: 0,
      active: 0,
      currentReplicas: 2,
    });

    expect(desired).toBe(1);
  });

  it('каждая тяжёлая задача требует отдельной реплики', () => {
    // jobsPerReplica = 1: две задачи в очереди — это две реплики
    const desired = computeDesiredReplicas('heavy', {
      waiting: 2,
      active: 0,
      currentReplicas: 1,
    });

    expect(desired).toBe(2);
  });

  it('лёгкие задачи идут по пять на реплику', () => {
    const desired = computeDesiredReplicas('light', {
      waiting: 11,
      active: 0,
      currentReplicas: 1,
    });

    // 11 / 5 = 2.2, округление вверх даёт 3
    expect(desired).toBe(3);
  });

  it('активные задачи считаются вместе с ожидающими', () => {
    // Реплика, занятая конвертацией, для очереди недоступна: если считать
    // только waiting, воркеры будут вечно догонять нагрузку
    const desired = computeDesiredReplicas('medium', {
      waiting: 1,
      active: 1,
      currentReplicas: 1,
    });

    expect(desired).toBe(1);

    const more = computeDesiredReplicas('medium', {
      waiting: 2,
      active: 2,
      currentReplicas: 1,
    });

    expect(more).toBe(2);
  });

  it('не превышает потолок реплик', () => {
    const desired = computeDesiredReplicas('heavy', {
      waiting: 100,
      active: 0,
      currentReplicas: 1,
    });

    expect(desired).toBe(SCALING_PROFILES.heavy.max);
  });
});

describe('Автомасштабирование: ограничение шага', () => {
  it('рост ограничивается одним шагом', () => {
    expect(limitStep(10, 1, 1)).toBe(2);
  });

  it('снижение ограничивается одним шагом', () => {
    expect(limitStep(1, 5, 1)).toBe(4);
  });

  it('совпадение не меняет число реплик', () => {
    expect(limitStep(3, 3, 1)).toBe(3);
  });
});

describe('Автомасштабирование: остывание', () => {
  it('снижение откладывается на время остывания', () => {
    const cooldown = SCALING_PROFILES.medium.cooldownMs;
    const lastScaleDown = 1_000_000;

    // Прошло меньше времени остывания — снижать нельзя
    expect(canScaleDown(1, 3, lastScaleDown, cooldown, lastScaleDown + 1000)).toBe(false);

    // Остывание истекло
    expect(canScaleDown(1, 3, lastScaleDown, cooldown, lastScaleDown + cooldown)).toBe(true);
  });

  it('рост не зависит от остывания', () => {
    expect(canScaleDown(5, 2, Date.now(), 600000, Date.now())).toBe(true);
  });
});

describe('Автомасштабирование: путь к сокету движка', () => {
  it('по умолчанию берётся сокет Docker на Linux', () => {
    expect(resolveDockerSocketPath({})).toBe('/var/run/docker.sock');
  });

  it('DOCKER_SOCKET_PATH главнее DOCKER_HOST', () => {
    // Своя переменная задана явно — соглашение не должно её перебивать
    const path = resolveDockerSocketPath({
      DOCKER_SOCKET_PATH: '/run/podman/podman.sock',
      DOCKER_HOST: 'unix:///run/user/1000/podman/podman.sock',
    });

    expect(path).toBe('/run/podman/podman.sock');
  });

  it('DOCKER_HOST принимается в форме unix://', () => {
    // Именно такую строку печатает podman info --format
    // '{{.Host.RemoteSocket.Path}}', и она должна переноситься в .env как есть
    const path = resolveDockerSocketPath({
      DOCKER_HOST: 'unix:///run/user/501/podman/podman.sock',
    });

    expect(path).toBe('/run/user/501/podman/podman.sock');
  });

  it('голый путь принимается в обеих переменных', () => {
    expect(resolveDockerSocketPath({ DOCKER_HOST: '/run/podman/podman.sock' })).toBe(
      '/run/podman/podman.sock'
    );
  });

  it('пустые значения не перебивают значение по умолчанию', () => {
    expect(resolveDockerSocketPath({ DOCKER_SOCKET_PATH: '  ', DOCKER_HOST: '' })).toBe(
      '/var/run/docker.sock'
    );
  });

  it('неподдерживаемая схема — отказ, а не молчаливый переход на сокет по умолчанию', () => {
    // tcp:// подставляет Docker Desktop; клиент автоскейлера умеет только
    // unix-сокет, и работать «как будто ничего не задано» здесь нельзя:
    // адрес в окружении и адрес обращения разошлись бы молча
    expect(() => resolveDockerSocketPath({ DOCKER_HOST: 'tcp://127.0.0.1:2375' })).toThrow(
      /DOCKER_HOST/
    );

    expect(() => resolveDockerSocketPath({ DOCKER_HOST: 'ssh://user@host' })).toThrow(
      /unix/
    );
  });

  it('unix:// без абсолютного пути отвергается', () => {
    expect(() => resolveDockerSocketPath({ DOCKER_HOST: 'unix://relative/podman.sock' })).toThrow(
      /unix:\/\/\//
    );
  });
});
