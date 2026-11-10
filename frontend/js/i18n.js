const messages = {
  ru: {
    projectName: 'Голос команды',
    languageLabel: 'Язык интерфейса',
    loginTitle: 'Вход в систему',
    loginHint: 'Введите рабочий номер телефона и пароль.',
    phoneLabel: 'Номер телефона',
    phoneHint: 'Казахстан: +7 (7XX) XXX-XX-XX или 8 (7XX) XXX-XX-XX.',
    passwordLabel: 'Пароль',
    showPassword: 'Показать',
    hidePassword: 'Скрыть',
    signIn: 'Войти',
    signingIn: 'Проверка…',
    accessNote: 'Нет доступа? Обратитесь к администратору',
    phoneRequired: 'Введите номер телефона.',
    phoneInvalid: 'Введите номер Казахстана: +7 (7XX) XXX-XX-XX или 8 (7XX) XXX-XX-XX.',
    passwordRequired: 'Введите пароль.',
    backendUnavailable: 'Подключение к серверу ещё не готово. Вход пока недоступен.',
    loginUnavailable: 'Поля заполнены корректно. Подключение к серверу ещё не готово — вход не выполнен.',
  },
  kk: {
    projectName: 'Команда дауысы',
    languageLabel: 'Интерфейс тілі',
    loginTitle: 'Жүйеге кіру',
    loginHint: 'Жұмыс телефон нөмірі мен құпиясөзді енгізіңіз.',
    phoneLabel: 'Телефон нөмірі',
    phoneHint: 'Қазақстан: +7 (7XX) XXX-XX-XX немесе 8 (7XX) XXX-XX-XX.',
    passwordLabel: 'Құпиясөз',
    showPassword: 'Көрсету',
    hidePassword: 'Жасыру',
    signIn: 'Кіру',
    signingIn: 'Тексерілуде…',
    accessNote: 'Кіру мүмкін емес пе? Әкімшіге хабарласыңыз',
    phoneRequired: 'Телефон нөмірін енгізіңіз.',
    phoneInvalid: 'Қазақстан нөмірін енгізіңіз: +7 (7XX) XXX-XX-XX немесе 8 (7XX) XXX-XX-XX.',
    passwordRequired: 'Құпиясөзді енгізіңіз.',
    backendUnavailable: 'Серверге қосылу әлі дайын емес. Жүйеге кіру әзірге қолжетімсіз.',
    loginUnavailable: 'Өрістер дұрыс толтырылған. Серверге қосылу әлі дайын емес — жүйеге кіру орындалмады.',
  },
};

let language = 'ru';

export function t(key) {
  return messages[language][key];
}

export function setLanguage(nextLanguage) {
  if (!Object.hasOwn(messages, nextLanguage)) return;
  language = nextLanguage;
  document.documentElement.lang = language;
  document.title = t('projectName');
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-label]').forEach((element) => {
    element.setAttribute('aria-label', t(element.dataset.i18nLabel));
  });
  document.querySelectorAll('[data-language]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  });
}
