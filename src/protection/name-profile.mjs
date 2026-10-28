import { canonical, namePools } from './name-styles.mjs';
// Naming conventions, not assertions about a person's gender or ethnicity.
// Locale-specific lists avoid treating an ambiguous spelling as demographic fact.
const groups = {
 en: ['John James Michael David Daniel Robert William Thomas Joseph Henry George Edward Peter Paul Mark Richard Charles Andrew Matthew Samuel Benjamin Jack Oliver Liam Noah Ethan Lucas', 'Alice Emma Olivia Sophia Emily Elizabeth Mary Sarah Anna Hannah Grace Charlotte Amelia Abigail Nora Eleanor Victoria Julia Lucy Claire Rose Lily Maya Ava Zoe Laura Rachel Rebecca Jennifer Susan Jessica Patricia'],
 he: ['אורי איתן עידו גיא יוסף דוד משה אברהם יצחק דניאל יונתן אלון רועי עומר', 'יעל נועה תמר דנה מיכל אלה מאיה שרה רחל רבקה לאה אסתר אביגיל שירה איילה'],
 he_latn: ['Uri Eitan Ido Guy Yosef David Moshe Avraham Yitzhak Daniel Yonatan Alon Roy Omer', 'Yael Noa Tamar Dana Michal Ella Maya Sarah Rachel Rivka Leah Esther Abigail Shira Ayala'],
 ru: ['Алексей Андрей Борис Виктор Дмитрий Иван Кирилл Михаил Олег Павел Сергей Юрий Николай Александр', 'Анна Вера Дарья Елена Ирина Марина Наталья Ольга Мария София Екатерина Анастасия Татьяна'],
 ru_latn: ['Alexei Andrei Boris Viktor Dmitri Ivan Kirill Mikhail Oleg Pavel Sergei Yuri Nikolai Alexander', 'Anna Vera Daria Elena Irina Marina Natalia Olga Maria Sofia Ekaterina Anastasia Tatiana'],
 ar: ['أحمد عمر سامي يوسف كريم علي حسن خالد نادر طارق محمد إبراهيم', 'ليلى مريم رنا سارة هالة سلمى ريم ياسمين منى فاطمة عائشة'],
 ar_latn: ['Ahmad Omar Sami Yusuf Karim Ali Hasan Khaled Nader Tarek Muhammad Ibrahim', 'Layla Mariam Rana Sara Hala Salma Reem Yasmin Mona Fatima Aisha'],
 es: ['Alejandro Diego Enrique Fernando Javier José Manuel Mateo Pablo Raúl Rodrigo', 'Carmen Elena Inés Isabel Lucía María Natalia Paula Sofía'],
 fr: ['Adrien Étienne Gabriel Hugo Julien Laurent Nicolas Olivier Rémi Sébastien Théo', 'Chloé Élodie Florence Isabelle Léa Lucie Margaux Mathilde'],
 de: ['Bernd Dieter Ernst Franz Hans Jens Klaus Lars Lukas Matthias Stefan', 'Anke Britta Greta Heike Ingrid Johanna Lena Petra Ute'],
 it: ['Alessandro Andrea Davide Federico Lorenzo Luca Marco Matteo Paolo Pietro Roberto Stefano', 'Chiara Elena Francesca Giulia Lucia Sara Silvia Valentina'],
 pt: ['Afonso Bruno Diogo Duarte Gonçalo João Luís Miguel Nuno Pedro Rafael Tiago', 'Ana Beatriz Catarina Inês Leonor Mariana Rita Vitória'],
 tr: ['Ahmet Burak Can Cem Emre Eren Hakan Kemal Mert Murat', 'Ayşe Ece Elif Esra Fatma İpek Selin Zeynep'],
};
const lists = Object.fromEntries(Object.entries(groups).map(([locale, pair]) => [locale, pair.map(s => s.split(' '))]));
export function genderStyle(word, locale) {
 const pair=lists[locale]; if(!pair) return 'unknown';
 const key=canonical(word), male=pair[0].some(v=>canonical(v)===key), female=pair[1].some(v=>canonical(v)===key);
 return male!==female ? male?'masculine':'feminine' : 'unknown';
}
export function givenPool(locale, gender) {
 const pair=lists[locale];
 return pair && gender!=='unknown' ? pair[gender==='masculine'?0:1] : (namePools[locale] || namePools.en).first;
}
export function familyPool(locale, source) {
 const list=(namePools[locale]||namePools.en).last;
 if(locale==='ru' && /(?:ова|ева|ёва|ина|ая)$/iu.test(source)) return list.map(v=>/ий$/u.test(v)?v.slice(0,-2)+'ая':v+'а');
 if(locale==='ru_latn' && /(?:ova|eva|ina|aya)$/i.test(source)) return list.map(v=>/iy$/i.test(v)?v.slice(0,-2)+'aya':v+'a');
 return list;
}
// Known native/Latin spellings share an email representation. Never guess an
// arbitrary transliteration, nationality or identity from an email domain.
const roman = new Map();
for(const locale of ['he','ru','ar']) for(const kind of ['first','last']) {
 namePools[locale][kind].forEach((word,i)=>roman.set(canonical(word),namePools[locale+'_latn'][kind][i].toLowerCase()));
}
for (const locale of ['he','ru','ar']) for (let g=0;g<2;g++) {
 lists[locale][g].forEach((word,i)=>roman.set(canonical(word),lists[locale+'_latn'][g][i].toLowerCase()));
}
export function emailSpelling(value) {
 const normalized=canonical(value);
 if(roman.has(normalized))return roman.get(normalized);
 if(/\p{Script=Cyrillic}/u.test(value) && /а$/u.test(normalized) && roman.has(normalized.slice(0,-1)))return roman.get(normalized.slice(0,-1))+'a';
 return normalized.normalize('NFD').replace(/\p{M}/gu,'').replace(/['’ -]/g,'');
}
