// Small offline spelling-style pools, not a nationality or ethnicity classifier.
// Ambiguous Latin spellings use the user's fallback. Native scripts take priority.
export const canonical = value => value.normalize('NFKC').toLowerCase();
const pool = (first, last, alphabet) => ({ first: first.split(' '), last: last.split(' '), alphabet });
const latin = 'abcdefghijklmnopqrstuvwxyz';
export const namePools = {
  en: pool('Alex Avery Bailey Blair Cameron Casey Charlie Dakota Dana Devon Drew Eden Elliot Emery Finley Frankie Harper Hayden Jamie Jordan Jules Kendall Lane Logan Marley Morgan Nico Parker Peyton Quinn Reese Remy Riley Robin Rowan Sage Sam Sasha Sawyer Shannon Sidney Skyler Taylor Terry Toby Wren', 'Adams Archer Bailey Baker Barrett Bennett Blake Brooks Carter Clark Collins Cooper Davis Dawson Ellis Evans Fisher Fletcher Ford Foster Fox Gardner Graham Grant Gray Green Griffin Hall Harper Hayes Hill Howard Hudson Hunt James Kelly King Lane Lewis Martin Mason Miller Moore Morgan Murphy Palmer Parker Perry Porter Reed Reid Riley Rivers Ross Russell Scott Shaw Spencer Stone Taylor Turner Walker Ward Warren Wells West White Wilson Wood Wright Young', latin),
  he: pool('אורי יעל נועה איתן תמר עידו דנה רוני נועם שי מיכל עמית יובל עדי טל גיא אלה ליאור מאיה ירדן', 'כהן לוי מזרחי פרץ ביטון דהן אברהם פרידמן שפירא גולן שחר רוזן סגל ברק הדר כרמל לביא שרון קדם גבע', 'אבגדהוזחטיכלמנסעפצקרשת'),
  he_latn: pool('Uri Yael Noa Eitan Tamar Ido Dana Roni Noam Shai Michal Amit Yuval Adi Tal Guy Ella Lior Maya Yarden', 'Cohen Levi Mizrahi Peretz Biton Dahan Avraham Friedman Shapira Golan Shahar Rosen Segal Barak Hadar Carmel Lavi Sharon Kedem Geva', latin),
  ru: pool('Алексей Андрей Анна Борис Вера Виктор Дарья Дмитрий Елена Иван Ирина Кирилл Марина Михаил Наталья Олег Ольга Павел Сергей Юрий', 'Иванов Петров Соколов Смирнов Волков Морозов Козлов Новиков Фёдоров Орлов Васильев Макаров Захаров Попов Романов Кузнецов Беляев Титов Громов Лебедев', 'абвгдежзийклмнопрстуфхцчшщэюя'),
  ru_latn: pool('Alexei Andrei Anna Boris Vera Viktor Daria Dmitri Elena Ivan Irina Kirill Marina Mikhail Natalia Oleg Olga Pavel Sergei Yuri', 'Ivanov Petrov Sokolov Smirnov Volkov Morozov Kozlov Novikov Fedorov Orlov Vasiliev Makarov Zakharov Popov Romanov Kuznetsov Belyaev Titov Gromov Lebedev', latin),
  ar: pool('أحمد عمر ليلى مريم نور سامي رنا سارة يوسف كريم هالة علي حسن سلمى خالد نادر ريم ياسمين طارق منى', 'منصور ناصر حمدان خليل حداد سليم عوض شاهين حمود موسى عيسى مراد سعيد عباس رشيد نجار صالح قاسم يونس سالم', 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي'),
  ar_latn: pool('Ahmad Omar Layla Mariam Nour Sami Rana Sara Yusuf Karim Hala Ali Hasan Salma Khaled Nader Reem Yasmin Tarek Mona', 'Mansour Nasser Hamdan Khalil Haddad Salim Awad Shaheen Hammoud Moussa Issa Murad Saeed Abbas Rashid Najjar Saleh Qasim Younis Salem', latin),
  es: pool('Alejandro Carmen Diego Elena Enrique Fernando Inés Isabel Javier José Lucía Manuel María Mateo Natalia Pablo Paula Raúl Rodrigo Sofía', 'García Fernández González Hernández López Martínez Pérez Rodríguez Sánchez Álvarez Castillo Delgado Domínguez Herrera Moreno Navarro Ortega Romero Torres Vargas', latin),
  fr: pool('Adrien Camille Chloé Élodie Étienne Florence Gabriel Hugo Isabelle Julien Laurent Léa Lucie Margaux Mathilde Nicolas Olivier Rémi Sébastien Théo', 'Bernard Bertrand Bonnet Chevalier Dubois Dumont Dupont Fontaine Fournier Garnier Girard Lambert Laurent Lefèvre Marchand Moreau Perrin Petit Renault Rousseau', latin),
  de: pool('Anke Bernd Britta Dieter Ernst Franz Greta Hans Heike Ingrid Jens Johanna Klaus Lars Lena Lukas Matthias Petra Stefan Ute', 'Bauer Becker Braun Fischer Hoffmann Keller Klein Koch König Krause Lange Müller Richter Schäfer Schmitt Schneider Schulz Wagner Weber Zimmermann', latin),
  it: pool('Alessandro Andrea Chiara Davide Elena Federico Francesca Giulia Lorenzo Luca Lucia Marco Matteo Paolo Pietro Roberto Sara Silvia Stefano Valentina', 'Bianchi Conti Costa DeLuca Esposito Ferrara Ferrari Gallo Giordano Greco Lombardi Mancini Marino Moretti Ricci Romano Rinaldi Rossi Russo Vitale', latin),
  pt: pool('Afonso Ana Beatriz Bruno Catarina Diogo Duarte Gonçalo Inês João Leonor Luís Mariana Miguel Nuno Pedro Rafael Rita Tiago Vitória', 'Almeida Alves Azevedo Barbosa Cardoso Carvalho Correia Costa Fernandes Ferreira Gomes Lopes Martins Mendes Pereira Ribeiro Rodrigues Santos Silva Teixeira', latin),
  tr: pool('Ahmet Ayşe Burak Can Cem Deniz Derya Ece Elif Emre Eren Esra Fatma Hakan İpek Kemal Mert Murat Selin Zeynep', 'Aksoy Arslan Aydın Çelik Demir Doğan Güneş Kaya Koç Kurt Özdemir Öztürk Polat Şahin Şimşek Taş Tekin Yıldırım Yılmaz Yücel', 'abcçdefgğhıijklmnoöprsştuüvyz'),
  zh: pool('伟 芳 娜 敏 静 丽 强 磊 军 洋 勇 艳 杰 涛 明 秀英 晓明 建国 雅婷 志强', '王 李 张 刘 陈 杨 赵 黄 周 吴 徐 孙 胡 朱 高 林 何 郭 马 罗', '安博春东芳光海佳康岚明宁平清荣山涛文新远'),
  ja: pool('はるか ひなた あかり さくら なおき たくみ まこと みさき ゆうき りょう', 'たなか さとう すずき たかはし わたなべ いとう やまもと なかむら こばやし さいとう', 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわ'),
  ko: pool('민준 서준 도윤 예준 시우 하준 지호 주원 지우 서연 서윤 지유 하은 수아 윤서', '김 이 박 최 정 강 조 윤 장 임 한 오 서 신 권 황 안 송 류 홍', '가나다라모민서수아연우유은정준지진하현호'),
};
export const nameStyleOptions = [
  ['auto', 'Automatic spelling style'], ['en', 'English / international'], ['he_latn', 'Hebrew (Latin spelling)'], ['ru_latn', 'Russian (Latin spelling)'], ['ar_latn', 'Arabic (Latin spelling)'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['tr', 'Turkish'],
];
const native = [[/\p{Script=Hebrew}/u, 'he'], [/\p{Script=Arabic}/u, 'ar'], [/\p{Script=Cyrillic}/u, 'ru'], [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'ja'], [/\p{Script=Hangul}/u, 'ko'], [/\p{Script=Han}/u, 'zh']];
const index = new Map();
for (const [locale, data] of Object.entries(namePools)) for (const word of [...data.first, ...data.last]) {
  const key = canonical(word); if (!index.has(key)) index.set(key, new Set()); index.get(key).add(locale);
}
export function nameStyle(value, preference = 'auto') {
  const script = native.find(([pattern]) => pattern.test(value));
  if (script) return { locale: script[1], basis: 'script' };
  if (preference !== 'auto') return { locale: preference, basis: 'selected' };
  const scores = new Map();
  for (const token of value.match(/\p{L}+/gu) || []) {
    const matches = index.get(canonical(token));
    if (matches?.size === 1) { const locale = [...matches][0]; scores.set(locale, (scores.get(locale) || 0) + 1); }
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  return ranked.length && (!ranked[1] || ranked[0][1] > ranked[1][1]) ? { locale: ranked[0][0], basis: 'spelling-pool' } : { locale: 'en', basis: 'fallback' };
}
// Keep unrecognized scripts instead of silently converting them to Latin.
export function sameScript(a, b) {
  for (const script of ['Latin', 'Hebrew', 'Arabic', 'Cyrillic', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Greek', 'Devanagari', 'Thai']) {
    const re = new RegExp(`\\p{Script=${script}}`, 'u');
    if (re.test(a) !== re.test(b)) return false;
  }
  return true;
}
