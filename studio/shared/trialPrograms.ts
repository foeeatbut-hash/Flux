/**
 * Обращение к другой программе в пробном запуске Studio.
 *
 * На тестовой базе других программ нет: «установлены у человека» здесь некому, поэтому вызов отвечает NOT_INSTALLED, как во Flux
 * у человека, которому нужная программа не ставилась. Разрешение и форму вызова до этого уже проверил мост (modules/bridge.ts) по
 * манифесту запущенного проекта — вызов без разрешения program получит NOT_ALLOWED, не доходя сюда. Программа должна уметь
 * жить с этим ответом: её настоящий вид с установленной программой проверяют во Flux, в тестовом канале.
 */
import type { ProgramCall, ProgramReply } from '../../modules/programs/model';

export function trialProgramCall(call: ProgramCall): { reply: ProgramReply; line: string } {
  return {
    reply: { ok: false, code: 'NOT_INSTALLED' },
    line: `«${call.program}».${call.method}: NOT_INSTALLED — в пробном запуске других программ нет; во Flux ответит установленная программа`,
  };
}
