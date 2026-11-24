const filters = document.querySelector('.filters');
if (filters) {
  const buttons = [...filters.querySelectorAll('[data-filter]')];
  const projects = [...document.querySelectorAll('[data-category]')];
  const status = document.querySelector('#project-status');

  filters.hidden = false;
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const filter = button.dataset.filter;
      for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
      for (const project of projects) {
        project.hidden = filter !== 'all' && project.dataset.category !== filter;
      }
      const count = projects.filter(project => !project.hidden).length;
      status.textContent = count === 1 ? '1 projeto exibido.' : count + ' projetos exibidos.';
    });
  }
}

const printButton = document.querySelector('[data-print]');
if (printButton) {
  printButton.hidden = false;
  printButton.addEventListener('click', () => window.print());
}
