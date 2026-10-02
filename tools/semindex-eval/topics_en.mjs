// English counterpart of topics.mjs. Same topics in the same order; gold[i] and q[i] are translations of the Japanese gold[i] and q[i]
// (so that, in a corpus that mixes the two languages, a Japanese question can find the English version of the same fact and the
// other way round). The questions avoid the key words of the gold sentences, as the Japanese ones do.
export const TOPICS_EN = [
  { id: 'bamboo', gold: [
    'Bamboo grows fast and can be harvested in about three years. As a building material it should put much less strain on the environment.',
    'Started a prototype flooring board by splitting moso bamboo into thin strips and laminating them. Warping is the open problem.',
    'Neglected bamboo groves are becoming a problem. Cutting them for materials would also help look after the village woodlands.'],
    q: ['ideas for sustainable construction materials', 'a plan to put abandoned countryside woodland to use'] },
  { id: 'sashigane', gold: [
    "Using the back scale of a carpenter's square gives the side of a square beam you can cut from a log. The back scale is the front scale multiplied by root two.",
    "To find the length of a diagonal member, put two points of the square's scale on it and read off the distance. It is just the Pythagorean theorem at work.",
    'Taught the younger staff how to use the framing square. Hardly anyone remembers how to work out a slope.'],
    q: ['how to work out the length of a slanted piece with a ruler', 'carpentry tools used to calculate a right triangle'] },
  { id: 'meeting', gold: [
    'Met Mr. Tanaka about the quote. We agreed on delivery at the end of next month, and there will be no extra charges.',
    'About the Yamamoto Trading job: they want the drawings by the 10th. If those slip, shipping slips too.'],
    q: ['the deadline we promised a client', 'a request about when the blueprints are due'] },
  { id: 'flooring', gold: [
    'Flooring production process: drying, planing, then UV oil coating. Keep the moisture content between 8 and 10 percent.',
    'Once moisture content exceeds 12 percent, gaps tend to open after installation. Review the temperature log of the drying kiln.'],
    q: ['steps for making floor boards and controlling humidity', 'why gaps appear between planks after they are laid'] },
  { id: 'health', gold: [
    'Trouble falling asleep lately. I will stop using my phone before bed and be under the covers by 11 pm.',
    'Morning run, 5 km. My knee felt odd, so I slowed the pace.'],
    q: ['ways to improve sleep quality', 'what to do when exercise causes pain'] },
  { id: 'go', gold: [
    'Before launching a huge number of goroutines, cap concurrency with a semaphore. A buffered channel is often enough.',
    'Forgot to pass the context cancellation along and leaked goroutines. errgroup makes it easier.'],
    q: ['how to limit the number of parallel tasks', 'a mechanism for stopping work halfway'] },
  { id: 'vpn', gold: [
    'Built the home VPN with WireGuard. Lowering the MTU to 1380 made the connection stable.',
    'Remote connections from outside drop now and then. The router keepalive setting may be the cause.'],
    q: ['settings for securely connecting to home from far away', 'the problem of the link cutting out every so often'] },
  { id: 'recipe', gold: [
    'Braised pork belly: parboil it, then 20 minutes in the pressure cooker. Season with soy sauce, sugar and mirin.',
    'Weekend shopping list: eggs, milk, green onions, tofu, chicken breast.'],
    q: ['how to make a stew tender in a short time', 'groceries to pick up this week'] },
  { id: 'books', gold: [
    'Finished reading "The Essence of Failure". The part about organizations clinging to past success and failing to adapt really struck me.',
    'Reading note: habits are decided by environment design. Do not rely on willpower; leave cues in place.'],
    q: ['why successful companies go into decline', 'how to build a habit that lasts'] },
  { id: 'travel', gold: [
    "Next month's Kyoto trip is two nights, three days. Visit Fushimi Inari early in the morning. The inn near Shijo is already booked.",
    'Travel budget is 80,000 yen per person. Booked the bullet train with an early-bird discount.'],
    q: ['plans for a business trip combined with a holiday in western Japan', 'outlook for how much getting around will cost'] },
  { id: 'printer', gold: [
    'A clogged 3D printer nozzle was fixed by raising the temperature and pulling out the filament, the cold pull method.',
    'ABS warps easily so I built my own enclosure. PETG is easier to handle.'],
    q: ['how to repair a fabrication machine whose outlet is blocked', 'which plastics are easiest to work with'] },
  { id: 'estimate', gold: [
    'Rebuilt the quotation template. Add a 10 percent contingency on top of materials.',
    'Invoices are issued at month end, payable on the 15th of the following month. Accounting handles checking incoming payments.'],
    q: ['how to leave some margin when estimating costs', 'rules for when payment is due'] },
  { id: 'photo', gold: ['For backlit shots at dusk, set exposure compensation to +1. Lock white balance to cloudy.'], q: ['tips for brightening a sunset scene'] },
  { id: 'garden', gold: ['Planted tomato seedlings. If you do not pinch off the side shoots early, the fruit stays small.'], q: ['how to grow vegetables so the harvest is bigger'] },
  { id: 'english', gold: ['Language study: ten minutes of shadowing every morning. My listening has slowly started to improve.'], q: ['practice to build the ability to understand a foreign tongue by ear'] },
  { id: 'car', gold: ['Oil change every 5,000 km. Replace the tires before the tread drops below 1.6 mm.'], q: ['a guideline for regular vehicle maintenance'] }
];

// Questions that mix the two languages the way a person who writes both does: a Japanese sentence with the English term in it.
// They are asked of the corpus that mixes the two languages; the right notes are all the golds of the topic, in either language.
export const MIXED_QUERIES = [
  { topic: 'go', q: 'goroutine の同時実行数を制限する書き方' },
  { topic: 'vpn', q: 'WireGuard の MTU 設定でつながりが安定した話' },
  { topic: 'flooring', q: 'フローリングの moisture content と隙間の関係' },
  { topic: 'printer', q: 'PETG と ABS の扱いやすさの違い' },
  { topic: 'photo', q: '逆光のときの exposure と white balance' },
  { topic: 'estimate', q: '見積書の contingency を何% 乗せるか' },
  { topic: 'bamboo', q: 'moso bamboo の積層フローリング試作' },
  { topic: 'travel', q: 'Kyoto trip の予算と bullet train' }
];

// Sentences that share key words with the topics but are NOT the facts above.
export const DISTRACTORS_EN = [
  'Checked the bamboo stock. Only a little is left at the back of the warehouse.', "Sent the carpenter's square out to be sharpened. It comes back next week.", 'Cleaned the floor. Wax tomorrow.',
  'Swapped my sleep app. The notifications are annoying.', 'Put the meeting minutes in the shared folder.', 'Upgraded the Go version. The build passed.',
  'The VPN renewal notice came. It expires next year.', 'Sent a photo of the braised pork to my sister.', 'Tidied the bookshelf. Finished books went into a box.',
  'Looking for a template for a trip itinerary.', 'Cleaned the exhaust fan in the 3D printer room.', 'Double-checked the quote figures with a calculator.',
  'Charged the camera battery.', 'Weeding the garden. My back hurts.', 'Fell asleep watching a video in English.', 'Washed the car. The wipers chatter.'
];

export const FILLER_EN = [
  "Today's to-do: reply to email, check invoices, clean up, shop.", 'Went to the gym first thing.', 'The meeting ran long and nothing got done.',
  'The new keyboard arrived. The typing feel is not bad.', 'Rain again, the laundry will not dry.', 'Running low on coffee beans.', 'Writing the weekly report. Mostly small improvements this week.',
  'Looking for a book to read on the train.', 'Replied to a message from a friend.', 'Made a backup.', 'The parking contract renewal papers arrived.',
  'Soba for lunch. Something light tonight.', 'Too many browser tabs. Time to tidy up.', 'Booked a dentist appointment.', 'Fixed typos in the document.',
  'Early start tomorrow. Set the alarm for 5:30.', 'Had an idea, jotting it down. Will sort it out later.', 'Added to the daily log.', 'Forgot to buy batteries.',
  'The Wi-Fi is acting up. A restart fixed it.', "Checking next week's schedule.", 'Sorted the receipts in my wallet.'
];
