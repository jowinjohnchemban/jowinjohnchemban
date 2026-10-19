// Everything personal about this profile lives in this file.
// To make it yours: fork the repo, rename it to your username, edit this file,
// and run the "Refresh profile" workflow. README.md and assets/ are generated from here,
// so edit this file rather than README.md.

export default {
  // GitHub username the dashboard is built for. In Actions it defaults to the repo owner.
  login: process.env.GH_LOGIN || 'jowinjohnchemban',

  name: 'Jowin John Chemban',
  greeting: "Hi there, I'm",
  location: 'Kerala, India',
  website: 'jowinjc.in',

  // Lines that rotate under your name in the animated header.
  roles: [
    'Cloud Solutions · Systems · Network Engineering',
    'Security · Full-Stack Development',
    'DevOps · Platform Engineering · Automation · CI/CD',
    'Linux · Windows · AWS · Azure · GCP · Cloudflare',
  ],

  // Shown as a centred row under the header. `bold` marks the ones to emphasise.
  links: [
    { label: 'Website', url: 'https://jowinjc.in', bold: true },
    { label: 'LinkedIn', url: 'https://linkedin.com/in/jowinjohnchemban', bold: true },
    { label: 'X', url: 'https://x.com/jowinchemban' },
    { label: 'Kaggle', url: 'https://www.kaggle.com/jowinjohnchemban' },
    { label: 'HackerRank', url: 'https://www.hackerrank.com/profile/jowinjohnchemban' },
    { label: 'CodePen', url: 'https://codepen.io/jowinjohnchemban' },
    { label: 'DEV', url: 'https://dev.to/jowinjohnchemban' },
    { label: 'Instagram', url: 'https://www.instagram.com/jowinjohnchemban' },
  ],

  // "About me" paragraphs and bullet points. Markdown is allowed.
  about: [
    'I design, build and support secure, scalable and reliable technology environments. My work spans computing platforms, systems design and administration, network engineering, security, DevOps, infrastructure automation and software development, so I can bridge the gap between infrastructure, applications and modern platforms.',
    "I like solving technical problems by making systems more reliable, secure and efficient, through automation, optimisation and careful engineering. Whether it's infrastructure, enterprise systems, networking or application development, I aim for solutions that are practical, scalable, maintainable and resilient.",
    "Outside work, I build personal projects: utility tools, system customisation, electronics and embedded gadgets, automation and native apps, often in support of a meaningful cause. I'm also into wireless technology, hardware security, telecommunications, reverse engineering, protocol analysis, digital forensics, intelligence and applied security research.",
  ],
  highlights: [
    ['🧭', 'Core expertise', 'cloud computing (AWS · Azure · Google Cloud) · IT infrastructure · systems administration · Linux · network engineering · DevOps · CI/CD · automation · security · full-stack development · AI/LLM prompting'],
    ['🌱', 'What I value', "curiosity, continuous learning, and technology that's secure, scalable and built to last"],
    ['💼', 'Open to', 'opportunities to contribute, learn and grow on meaningful engineering challenges'],
    ['📍', 'Based in', 'Kerala, India'],
    ['🤝', 'Get in touch', '[jowinjc.in/connect](https://jowinjc.in/connect)'],
  ],

  // Tech stack card: [group, [items]].
  stack: [
    ['Cloud', ['AWS', 'Azure', 'Google Cloud', 'Cloudflare', 'Firebase']],
    ['Infrastructure', ['Linux', 'Windows', 'Networking', 'Security']],
    ['DevOps', ['Docker', 'Git', 'CI/CD', 'Bash', 'Selenium']],
    ['Development', ['C', 'C++', 'Python', 'JavaScript', 'TypeScript', 'HTML']],
    ['Data & AI', ['TensorFlow', 'OpenCV', 'MySQL', 'SQL Server', 'Chart.js', 'LLM prompting']],
    ['Design', ['Photoshop', 'Illustrator']],
  ],

  // Turn whole sections on or off.
  sections: {
    about: true,
    stack: true,
    overview: true,
    heatmap: true,
    trend: true,
    rhythm: true,
    journey: true,
    openSource: true,
    projects: true,
  },

  projects: {
    count: 6,
    // Private repos need a PROFILE_TOKEN secret. They are listed by name and language only.
    includePrivate: true,
  },

  openSource: {
    recent: 8, // latest PRs, issues and discussions on other people's repos
    topRepos: 6,
  },

  languages: {
    exclude: [], // e.g. ['HTML', 'CSS'] to leave markup out of the language charts
  },

  timeZone: 'Asia/Kolkata',

  // Card colors. `series` is a colorblind-checked categorical order: keep the order if you change it.
  themes: {
    dark: {
      bg: '#0d1117', panel: '#161b22', border: '#30363d', text: '#e6edf3', muted: '#9198a1',
      accent: '#58a6ff', accent2: '#bc8cff',
      heat: ['#161b22', '#0d3a7a', '#1660d0', '#3f8cff', '#9ccaff'],
      series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
      other: '#6e7681',
    },
    light: {
      bg: '#ffffff', panel: '#f6f8fa', border: '#d0d7de', text: '#1f2328', muted: '#59636e',
      accent: '#0969da', accent2: '#8250df',
      heat: ['#eff2f5', '#c5dcff', '#7fb0fb', '#2f7de8', '#0a4aa6'],
      series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'],
      other: '#8c959f',
    },
  },
};
