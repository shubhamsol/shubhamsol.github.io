'use strict';



// element toggle function
const elementToggleFunc = function (elem) { elem.classList.toggle("active"); }



// sidebar variables
const sidebar = document.querySelector("[data-sidebar]");
const sidebarBtn = document.querySelector("[data-sidebar-btn]");

// sidebar toggle functionality for mobile
sidebarBtn.addEventListener("click", function () { elementToggleFunc(sidebar); });



// testimonials variables
const testimonialsItem = document.querySelectorAll("[data-testimonials-item]");
const modalContainer = document.querySelector("[data-modal-container]");
const modalCloseBtn = document.querySelector("[data-modal-close-btn]");
const overlay = document.querySelector("[data-overlay]");

// modal variable
const modalImg = document.querySelector("[data-modal-img]");
const modalTitle = document.querySelector("[data-modal-title]");
const modalText = document.querySelector("[data-modal-text]");

// modal toggle function
const testimonialsModalFunc = function () {
  modalContainer.classList.toggle("active");
  overlay.classList.toggle("active");
}

// add click event to all modal items
for (let i = 0; i < testimonialsItem.length; i++) {

  testimonialsItem[i].addEventListener("click", function () {

    // modalImg.src = this.querySelector("[data-testimonials-avatar]").src;
    // modalImg.alt = this.querySelector("[data-testimonials-avatar]").alt;
    // modalTitle.innerHTML = this.querySelector("[data-testimonials-title]").innerHTML;
    // modalText.innerHTML = this.querySelector("[data-testimonials-text]").innerHTML;

    testimonialsModalFunc();

  });

}

// add click event to modal close button
modalCloseBtn.addEventListener("click", testimonialsModalFunc);
overlay.addEventListener("click", testimonialsModalFunc);



// custom select variables
const select = document.querySelector("[data-select]");
const selectItems = document.querySelectorAll("[data-select-item]");
const selectValue = document.querySelector("[data-selecct-value]");
const filterBtn = document.querySelectorAll("[data-filter-btn]");

select.addEventListener("click", function () { elementToggleFunc(this); });

// add event in all select items
for (let i = 0; i < selectItems.length; i++) {
  selectItems[i].addEventListener("click", function () {

    let selectedValue = this.innerText.toLowerCase();
    selectValue.innerText = this.innerText;
    elementToggleFunc(select);
    filterFunc(selectedValue);

  });
}

// filter variables
const filterItems = document.querySelectorAll("[data-filter-item]");

const filterFunc = function (selectedValue) {
  for (let i = 0; i < filterItems.length; i++) {
    if (selectedValue === "all") {
      filterItems[i].classList.add("active");
    } else {
      const categories = filterItems[i].dataset.category.split(',');
      if (categories.includes(selectedValue.toLowerCase())) {
        filterItems[i].classList.add("active");
      } else {
        filterItems[i].classList.remove("active");
      }
    }
  }
}

// add event in all filter button items for large screen
let lastClickedBtn = filterBtn[0];

for (let i = 0; i < filterBtn.length; i++) {

  filterBtn[i].addEventListener("click", function () {

    let selectedValue = this.innerText.toLowerCase();
    selectValue.innerText = this.innerText;
    filterFunc(selectedValue);

    lastClickedBtn.classList.remove("active");
    this.classList.add("active");
    lastClickedBtn = this;

  });

}



// contact form variables
const form = document.querySelector("[data-form]");
const formInputs = document.querySelectorAll("[data-form-input]");
const formBtn = document.querySelector("[data-form-btn]");

// add event to all form input field
for (let i = 0; i < formInputs.length; i++) {
  formInputs[i].addEventListener("input", function () {
    // check form validation
    if (form.checkValidity()) {
      formBtn.removeAttribute("disabled");
    } else {
      formBtn.setAttribute("disabled", "");
    }
  });
}





// Portfolio modal
const portfolioModalContainer = document.createElement('div');
portfolioModalContainer.className = 'modal-container portfolio-modal-container';
document.body.appendChild(portfolioModalContainer);

portfolioModalContainer.innerHTML = `
  <div class="overlay" data-overlay></div>
  <section class="testimonials-modal">
    <button class="modal-close-btn" data-modal-close-btn>
      <ion-icon name="close-outline"></ion-icon>
    </button>
    <div class="modal-img-wrapper">
      <img src="" alt="Project preview">
    </div>
    <div class="modal-content">
      <h4 class="h3 modal-title"></h4>
      <p class="modal-text"></p>
      <div class="project-links">
        <a href="#" class="form-btn" target="_blank">View Live</a>
      </div>
    </div>
  </section>
`;

const projectItems = document.querySelectorAll('.project-item');
const projectModalImg = portfolioModalContainer.querySelector('.modal-img-wrapper img');
const projectModalTitle = portfolioModalContainer.querySelector('.modal-title');
const projectModalText = portfolioModalContainer.querySelector('.modal-text');
const projectModalLink = portfolioModalContainer.querySelector('.project-links a');
const projectModalCloseBtn = portfolioModalContainer.querySelector('.modal-close-btn');
const projectOverlay = portfolioModalContainer.querySelector('.overlay');

const projectDetails = {
  'RannBhumi': {
    description: 'A captivating 5v5 third-person hero battle game, meticulously crafted using Unity and powered by Photon Quantum for robust multiplayer functionality. Set against the backdrop of Indian mythology, the game introduces a diverse array of classes inspired by legendary figures.',
    link: './assets/videos/RannBhumi.mp4',
    hasVideo: true
  },
  'Rock Paper Scissor: Origins': {
    description: 'A top-down hero battle royale game featuring fast-paced 30-player matches. Developed using Unity and Photon Quantum with unique class system, shooting and dashing abilities. Implemented multiplayer networking, UI systems, and matchmaking with bots.',
    link: './assets/videos/RPS.mp4',
    hasVideo: true
  },
  'Zionverse': {
    description: 'A metaverse platform with multiplayer support for 30+ players using Photon Fusion. Implemented various user experiences including museum and aquarium. Features dynamic voxel map system for environment management.',
    link: './assets/videos/zionverse.mp4',
    hasVideo: true

  },
  'Flying Infinite': {
    description: 'A casual infinite space ship game with ship customization system and integrated Unity Ads for monetization. Features various skins and shop system.',
    link: './assets/videos/flyingInfinite.mp4',
    hasVideo: true

  },
  'Character Controller': {
    description: 'Advanced character controller using State Machine and Factory Pattern. Implements various states (Idle, Walk, Run, Jump, Hang) with seamless animation integration and optimized performance.',
    link: './assets/videos/CharacterController.mp4',
    hasVideo: true

  },
  'Unity DOTS RogueLite': {
    description: 'A prototype Roguelite game using Unity DOTS with XP system, gun mechanics, and dynamic enemy spawning. Leverages Unity job system for optimized performance.',
    link: './assets/videos/ECS.mp4',
    hasVideo: true

  }
};

const toggleProjectModal = () => {
  portfolioModalContainer.classList.toggle('active');
  if (!portfolioModalContainer.classList.contains('active')) {
    const existingVideo = portfolioModalContainer.querySelector('iframe');
    if (existingVideo) {
      existingVideo.remove();
    }
    projectModalImg.style.display = 'block';
  }
};

projectItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const projectTitle = item.querySelector('.project-title').textContent;
    const projectImg = item.querySelector('.project-img img').src;
    
    if (projectDetails[projectTitle]?.hasVideo) {
      projectModalImg.style.display = 'none';
      const videoEmbed = document.createElement('iframe');
      videoEmbed.width = '400px';
      videoEmbed.height = '400px';
      videoEmbed.src = projectDetails[projectTitle].link;
      videoEmbed.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      videoEmbed.allowFullscreen = true;
      
      // Remove existing video if any
      const existingVideo = projectModalImg.parentElement.querySelector('iframe');
      if (existingVideo) {
        existingVideo.remove();
      }
      
      projectModalImg.parentElement.appendChild(videoEmbed);
    } else {
      projectModalImg.style.display = 'block';
      projectModalImg.src = projectImg;
    }
    projectModalTitle.textContent = projectTitle;
    projectModalText.textContent = projectDetails[projectTitle]?.description || 'Project details coming soon.';
    projectModalLink.href = projectDetails[projectTitle]?.link || '#';
    
    toggleProjectModal();
  });
});

projectModalCloseBtn.addEventListener('click', toggleProjectModal);
projectOverlay.addEventListener('click', toggleProjectModal);

// page navigation variables
const navigationLinks = document.querySelectorAll("[data-nav-link]");
const pages = document.querySelectorAll("[data-page]");

// add event to all nav link
for (let i = 0; i < navigationLinks.length; i++) {
  navigationLinks[i].addEventListener("click", function () {

    for (let i = 0; i < pages.length; i++) {
      if (this.innerHTML.toLowerCase() === pages[i].dataset.page) {
        pages[i].classList.add("active");
        navigationLinks[i].classList.add("active");
        window.scrollTo(0, 0);
      } else {
        pages[i].classList.remove("active");
        navigationLinks[i].classList.remove("active");
      }
    }

  });
}