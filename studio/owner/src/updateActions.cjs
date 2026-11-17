'use strict';
/**
 * Обновление Flux выбранным и возврат версии — действия раздела «Flux: обновления» (Studio — Владелец).
 *
 * Лежит отдельно от console.cjs: там только регистрация. Окно ничего не подписывает и не решает: оно
 * называет действие, а здесь свежий список берётся с сервера, показывается своё окно подтверждения, и
 * только потом запись. Обычное назначение сотрудникам и подразделениям подписи не несёт (выпуск уже
 * подписан ключом владельца и проверяется у сотрудника при скачивании); возврат версии — обязательное
 * обновление, поэтому подписывается так же, как назначение по устройствам.
 */
const { signCampaign, CAMPAIGN_MAX_TARGETS } = require('./campaigns.ts');
const { rollbackPlan } = require('./rollbackPlan.ts');
const { coversUser } = require('../../../server/updateAudience.ts');

const text = (value, max = 200) => { if (typeof value !== 'string' || value.length > max) throw new Error('Некорректные данные формы.'); return value; };
const ids = value => (Array.isArray(value) ? value.map(x => text(x, 100)) : []);
const NAMES_SHOWN = 8;
const list = names => `${names.slice(0, NAMES_SHOWN).join(', ')}${names.length > NAMES_SHOWN ? ` и ещё ${names.length - NAMES_SHOWN}` : ''}`;

/** Имена действий: console.cjs добавляет их в список разрешённых окну */
const UPDATE_ACTION_NAMES = ['updateAudience', 'assignAudience', 'cancelAudience', 'rollbackAll'];

function createUpdateActions({ api, need, confirm, ctx }) {
  return {
    updateAudience: async () => api('GET', '/api/updates/audience'),

    assignAudience: async a => {
      const version = text(a.version, 40), userIds = ids(a.userIds), departmentIds = ids(a.departmentIds);
      const state = await api('GET', '/api/updates/audience');
      if (!state.releases.some(r => r.version === version)) throw new Error('Выпуск недоступен или отозван. Обновите список.');
      const people = userIds.map(id => state.users.find(u => u.id === id)), units = departmentIds.map(id => state.departments.find(d => d.id === id));
      if (people.includes(undefined) || units.includes(undefined)) throw new Error('Состав изменился: сотрудник или подразделение больше недоступны. Обновите список.');
      const covers = state.users.filter(u => coversUser({ userIds, departmentIds, cancelledAt: 0 }, u, state.departments)).length;
      await confirm(`Назначить обновление ${version}?`,
        `Получат сейчас: ${covers} чел.\n${units.length ? `Подразделения (с вложенными): ${list(units.map(d => d.name))}\n` : ''}${people.length ? `Сотрудники: ${list(people.map(u => u.name))}\n` : ''}`
        + '\nУ них появится плашка обновления; отложить его можно кнопкой «Позже». Кого добавят в подразделение позже, тоже получит обновление; кого выведут — перестанет получать, если ещё не поставил.');
      return api('POST', '/api/updates/assignments', { version, userIds, departmentIds });
    },

    cancelAudience: async a => {
      const id = text(a.id, 100);
      await confirm('Отменить назначение обновления?', 'Плашка исчезнет у тех, кто ещё не поставил. Уже установленная версия останется.');
      return api('POST', `/api/updates/assignments/${encodeURIComponent(id)}/cancel`, {});
    },

    /**
     * «Вернуть предыдущую версию всем»: обязательное обновление на предыдущий выпуск. Что вернётся и
     * у кого, считается здесь заново по свежему списку (окну не верим), подтверждается своим окном.
     */
    rollbackAll: async a => {
      const vault = need(), user = ctx.user();
      if (!user?.id) throw new Error('Подключитесь к общей БД.');
      const state = await api('GET', '/api/updates/devices'), plan = rollbackPlan(state.devices, state.releases);
      if (plan.error) throw new Error(plan.error);
      const minutes = Number(a.minutes);
      await confirm(`Вернуть всем версию ${plan.release.version}?`,
        `Сейчас у сотрудников стоит до ${plan.top}. У ${plan.people} чел. (${plan.targets.length} компьютеров) Flux через ${minutes} мин заменится версией ${plan.release.version}: это обязательное обновление, отложить его нельзя.`
        + `\n\nНовый выпуск не создаётся. Версия ${plan.top} остаётся опубликованной, но обычные назначения выпусков выше ${plan.release.version} отменяются.`
        + '\nПеред заменой Flux просит сохранить документы.');
      const done = [];
      for (let i = 0; i < plan.targets.length; i += CAMPAIGN_MAX_TARGETS) {
        const targets = plan.targets.slice(i, i + CAMPAIGN_MAX_TARGETS).map(d => ({ deviceId: d.deviceId, userId: d.userId, previous: d.commandId }));
        const signed = signCampaign(vault, { inst: state.inst, actor: user.id, action: 'schedule', rollback: true, minutes, release: plan.release, targets });
        try { done.push((await api('POST', '/api/updates/campaigns', signed)).id); }
        catch (e) {
          if (!done.length) throw e;
          throw new Error(`Возврат назначен только части компьютеров (${i} из ${plan.targets.length}): ${e.message}`);
        }
      }
      return { ids: done, version: plan.release.version, devices: plan.targets.length };
    },
  };
}

module.exports = { createUpdateActions, UPDATE_ACTION_NAMES };
