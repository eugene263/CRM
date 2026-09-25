// Маленький допоміжний скрипт для смок-тестів: викликає фонову перевірку
// регулярних задач ПРЯМО (в обхід tick(), який у тестовому середовищі
// свідомо рідкісний — CRM_TICK_MS=3600000), проти ТІЄЇ Ж бази, що й
// запущений тестовий сервер (той самий env, той самий CRM_DB/CRM_DATABASE_URL).
import { taskRecurrenceChecks } from '../src/taskBoards.js';

const result = await taskRecurrenceChecks();
process.stdout.write(JSON.stringify(result));
