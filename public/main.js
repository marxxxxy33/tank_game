import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const socket = typeof io !== 'undefined' ? io() : null;
const otherPlayers = {};

let currentSpeed = 0;
const TANK_TYPES = {
  heavy: {
    file: 'heavy_tank.glb', moveSpeed: 0.08, rotateSpeed: 0.02,
    rotationFix: Math.PI, gunOffset: 3.5, radius: 2.2,
    maxHp: 200, damage: 50, reloadTime: 1500
  },
  medium: {
    file: 'medium_tank.glb', moveSpeed: 0.1, rotateSpeed: 0.025,
    rotationFix: Math.PI, gunOffset: 2.8, radius: 1.8,
    maxHp: 120, damage: 30, reloadTime: 1000
  },
  light: {
    file: 'light_tank.glb', moveSpeed: 0.14, rotateSpeed: 0.035,
    rotationFix: 0, gunOffset: 2.0, radius: 1.4,
    maxHp: 70, damage: 15, reloadTime: 500
  }
};

let currentTankStats = null;
let isModelLoaded = false;
let tankTurret = null;
let tankModelGroup = new THREE.Group();

let currentHp = 100;
let lastShotTime = 0;

const bullets = [];
const obstacles = [];

const crosshair = document.getElementById('crosshair');
const reloadIndicator = document.getElementById('reload-indicator');
const hpBar = document.getElementById('hp-bar');
const hpText = document.getElementById('hp-text');
const killFeed = document.getElementById('kill-feed');

// --- СЦЕНА И КАМЕРА ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 35, 30);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const enemyGroup = new THREE.Group();
scene.add(enemyGroup);

// Свет
const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(40, 80, 40);
dirLight.castShadow = true;
scene.add(dirLight);

// --- КАРТА (ЗЕМЛЯ, СТЕНЫ, ДЕРЕВЬЯ, ЯЩИКИ) ---
function createMap() {
  // Земля
  const groundGeo = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x417724, roughness: 0.8 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Стены по краям
  const mapSize = 200, wallHeight = 6, wallThickness = 4;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.7 });
  const walls = [
    { x: 0, z: -mapSize / 2, w: mapSize, d: wallThickness },
    { x: 0, z: mapSize / 2, w: mapSize, d: wallThickness },
    { x: -mapSize / 2, z: 0, w: wallThickness, d: mapSize },
    { x: mapSize / 2, z: 0, w: wallThickness, d: mapSize }
  ];

  walls.forEach(w => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.w, wallHeight, w.d), wallMat);
    mesh.position.set(w.x, wallHeight / 2, w.z);
    mesh.castShadow = true;
    scene.add(mesh);
    obstacles.push({ minX: w.x - w.w / 2, maxX: w.x + w.w / 2, minZ: w.z - w.d / 2, maxZ: w.z + w.d / 2 });
  });

  // Ящики
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.6 });
  for (let i = 0; i < 15; i++) {
    const x = (Math.random() - 0.5) * 130;
    const z = (Math.random() - 0.5) * 130;
    const size = 3;

    const box = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), boxMat);
    box.position.set(x, size / 2, z);
    box.castShadow = true;
    box.receiveShadow = true;
    scene.add(box);

    obstacles.push({ minX: x - size / 2, maxX: x + size / 2, minZ: z - size / 2, maxZ: z + size / 2 });
  }

  // Деревья
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3d28 });
  const leavesMat = new THREE.MeshStandardMaterial({ color: 0x1e5e22, roughness: 0.5 });

  for (let i = 0; i < 20; i++) {
    const x = (Math.random() - 0.5) * 140;
    const z = (Math.random() - 0.5) * 140;

    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 4), trunkMat);
    trunk.position.y = 2;
    trunk.castShadow = true;
    tree.add(trunk);

    const leaves = new THREE.Mesh(new THREE.ConeGeometry(3, 7, 8), leavesMat);
    leaves.position.y = 6.5;
    leaves.castShadow = true;
    tree.add(leaves);

    tree.position.set(x, 0, z);
    scene.add(tree);

    obstacles.push({ minX: x - 1, maxX: x + 1, minZ: z - 1, maxZ: z + 1 });
  }
}
createMap();

const tankGroup = new THREE.Group();
tankGroup.add(tankModelGroup);
scene.add(tankGroup);

function updateHpUI() {
  if (!currentTankStats || !hpBar) return;
  const pct = Math.max(0, currentHp / currentTankStats.maxHp);
  hpBar.style.width = `${pct * 100}%`;
  if (hpText) hpText.textContent = `${Math.ceil(currentHp)} / ${currentTankStats.maxHp}`;
}

const loader = new GLTFLoader();
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const targetPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const mouseWorldPosition = new THREE.Vector3();

window.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  if (crosshair) {
    crosshair.style.left = `${e.clientX}px`;
    crosshair.style.top = `${e.clientY}px`;
  }
  if (reloadIndicator) {
    reloadIndicator.style.left = `${e.clientX}px`;
    reloadIndicator.style.top = `${e.clientY}px`;
  }
});

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) shoot();
});

function shoot() {
  if (!isModelLoaded || !currentTankStats || currentHp <= 0) return;
  const now = Date.now();
  if (now - lastShotTime < currentTankStats.reloadTime) return;
  lastShotTime = now;

  const baseDirection = new THREE.Vector3();
  if (tankTurret) {
    tankTurret.getWorldDirection(baseDirection);
  } else {
    tankGroup.getWorldDirection(baseDirection);
  }
  baseDirection.y = 0;
  baseDirection.normalize();

  const spawnPos = tankGroup.position.clone().addScaledVector(baseDirection, currentTankStats.gunOffset);
  spawnPos.y += 1.2;

  spawnBullet(spawnPos, baseDirection, socket ? socket.id : null, currentTankStats.damage);

  if (socket) {
    socket.emit('shoot', { pos: spawnPos, dir: baseDirection, damage: currentTankStats.damage });
  }
}

function spawnBullet(spawnPos, dir, ownerId, damage = 30) {
  const bulletGeo = new THREE.BoxGeometry(0.3, 0.3, 0.8);
  const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
  const bullet = new THREE.Mesh(bulletGeo, bulletMat);
  bullet.position.copy(spawnPos);
  bullet.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI;

  bullets.push({
    mesh: bullet, direction: dir, speed: 1.5,
    damage: damage, ownerId: ownerId, distanceTraveled: 0, maxDistance: 120
  });
  scene.add(bullet);
}

function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.mesh.position.addScaledVector(b.direction, b.speed);
    b.distanceTraveled += b.speed;

    const bx = b.mesh.position.x;
    const bz = b.mesh.position.z;
    let hit = false;

    for (const obs of obstacles) {
      if (bx >= obs.minX && bx <= obs.maxX && bz >= obs.minZ && bz <= obs.maxZ) {
        hit = true; break;
      }
    }

    if (!hit && socket && b.ownerId !== socket.id && isModelLoaded) {
      const dist = Math.hypot(bx - tankGroup.position.x, bz - tankGroup.position.z);
      if (dist < currentTankStats.radius) {
        hit = true;
        socket.emit('playerHit', { targetId: socket.id, damage: b.damage });
      }
    }

    if (hit || b.distanceTraveled >= b.maxDistance) {
      scene.remove(b.mesh);
      bullets.splice(i, 1);
    }
  }
}

// ВЫБОР ТАНКА
window.selectTank = function(type) {
  const nameInput = document.getElementById('player-name-input');
  const playerName = nameInput ? nameInput.value.trim() : 'Игрок';

  currentTankStats = TANK_TYPES[type];
  currentHp = currentTankStats.maxHp;
  tankTurret = null;
  isModelLoaded = false;

  while (tankModelGroup.children.length > 0) {
    tankModelGroup.remove(tankModelGroup.children[0]);
  }

  updateHpUI();

  const menu = document.getElementById('menu');
  if (menu) menu.style.display = 'none';
  if (crosshair) crosshair.style.display = 'block';
  if (reloadIndicator) reloadIndicator.style.display = 'block';
  document.body.style.cursor = 'none';

  if (socket) {
    socket.emit('joinGame', { name: playerName, type: type, maxHp: currentTankStats.maxHp });
  }

  loader.load(currentTankStats.file, (gltf) => {
    const tankMesh = gltf.scene;

    // Ищем деталь башни по именам, не ломая модель
    tankMesh.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        const name = child.name.toLowerCase();
        if (name.includes('turret') || name.includes('tower') || name.includes('gun') || name.includes('heavy') || name.includes('mid') || name.includes('light')) {
          if (!tankTurret) tankTurret = child;
        }
      }
    });

    tankMesh.rotation.y = currentTankStats.rotationFix;
    tankModelGroup.add(tankMesh);
    isModelLoaded = true;
  });
};

// СЕТЕВЫЕ СОБЫТИЯ
if (socket) {
  socket.on('initPlayer', (data) => {
    tankGroup.position.set(data.x, 0, data.z);
  });

  socket.on('currentPlayers', (players) => {
    Object.keys(players).forEach((id) => {
      if (id !== socket.id && !otherPlayers[id]) spawnEnemyTank(players[id]);
    });
  });

  socket.on('newPlayer', (playerInfo) => {
    if (!otherPlayers[playerInfo.id]) spawnEnemyTank(playerInfo);
  });

  socket.on('playerDisconnected', (id) => {
    if (otherPlayers[id]) {
      enemyGroup.remove(otherPlayers[id].mesh);
      delete otherPlayers[id];
    }
  });

  socket.on('playerMoved', (data) => {
    if (otherPlayers[data.id]) {
      otherPlayers[data.id].mesh.position.set(data.x, 0, data.z);
      otherPlayers[data.id].mesh.rotation.y = data.rotationY;
      if (otherPlayers[data.id].turret) {
        otherPlayers[data.id].turret.rotation.y = data.turretRotationY;
      }
    }
  });

  socket.on('playerShot', (data) => {
    spawnBullet(new THREE.Vector3(data.pos.x, data.pos.y, data.pos.z), new THREE.Vector3(data.dir.x, data.dir.y, data.dir.z), data.shooterId, data.damage);
  });

  socket.on('youDied', () => {
    currentHp = 0;
    updateHpUI();
    document.body.style.cursor = 'default';
    const menu = document.getElementById('menu');
    const menuTitle = document.getElementById('menu-title');
    if (menuTitle) menuTitle.textContent = 'Вас уничтожили! Выберите танк:';
    if (menu) menu.style.display = 'block';
    if (crosshair) crosshair.style.display = 'none';
    if (reloadIndicator) reloadIndicator.style.display = 'none';
  });

  socket.on('killEvent', (data) => {
    const msg = document.createElement('div');
    msg.className = 'kill-message';
    msg.innerHTML = `<span class="killer">${data.killer}</span> 💥 <span class="victim">${data.victim}</span>`;
    killFeed.appendChild(msg);
    setTimeout(() => msg.remove(), 5000);
  });
}

function spawnEnemyTank(playerInfo) {
  const stats = TANK_TYPES[playerInfo.type];
  loader.load(stats.file, (gltf) => {
    const enemyMesh = gltf.scene;
    let enemyTurret = null;

    enemyMesh.traverse((child) => {
      if (child.isMesh) {
        const name = child.name.toLowerCase();
        if (name.includes('turret') || name.includes('tower') || name.includes('gun')) {
          enemyTurret = child;
        }
      }
    });

    const enemyContainer = new THREE.Group();
    enemyContainer.position.set(playerInfo.x, 0, playerInfo.z);
    enemyMesh.rotation.y = stats.rotationFix;
    enemyContainer.add(enemyMesh);
    enemyGroup.add(enemyContainer);

    otherPlayers[playerInfo.id] = { mesh: enemyContainer, turret: enemyTurret };
  });
}

const keys = {};
window.addEventListener('keydown', (e) => { keys[e.code] = true; });
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

function updatePlayer() {
  if (!isModelLoaded || !currentTankStats || currentHp <= 0) return;

  const isW = keys['KeyW'] || keys['ArrowUp'];
  const isS = keys['KeyS'] || keys['ArrowDown'];

  let targetAccel = 0;
  if (isW) targetAccel -= currentTankStats.moveSpeed * 0.08;
  if (isS) targetAccel += currentTankStats.moveSpeed * 0.05;

  currentSpeed += targetAccel;
  currentSpeed *= 0.95;

  if (keys['KeyA'] || keys['ArrowLeft']) tankGroup.rotation.y += currentTankStats.rotateSpeed;
  if (keys['KeyD'] || keys['ArrowRight']) tankGroup.rotation.y -= currentTankStats.rotateSpeed;

  tankGroup.translateZ(currentSpeed);

  raycaster.setFromCamera(mouse, camera);
  raycaster.ray.intersectPlane(targetPlane, mouseWorldPosition);

  if (tankTurret) {
    const localTarget = tankGroup.worldToLocal(mouseWorldPosition.clone());
    tankTurret.rotation.y = Math.atan2(localTarget.x, localTarget.z) - currentTankStats.rotationFix;
  }

  if (socket) {
    socket.emit('playerUpdate', {
      x: tankGroup.position.x,
      z: tankGroup.position.z,
      rotationY: tankGroup.rotation.y,
      turretRotationY: tankTurret ? tankTurret.rotation.y : 0
    });
  }

  camera.position.x = tankGroup.position.x;
  camera.position.y = tankGroup.position.y + 35;
  camera.position.z = tankGroup.position.z + 30;
  camera.lookAt(tankGroup.position);
}

function animate() {
  requestAnimationFrame(animate);
  updatePlayer();
  updateBullets();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
