import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { AvatarPresentation } from "../avatar/avatarState";
import { createProceduralSaraAvatarDriver } from "../avatar/avatarDriver";

interface SaraAvatar3DProps {
  presentation: AvatarPresentation;
  outputAnalyser: AnalyserNode | null;
  resetCameraToken: number;
  onRendererError: (message: string) => void;
}

interface PoseInput extends AvatarPresentation {
  timeSeconds: number;
  deltaSeconds: number;
  speakingEnergy: number;
  blink: number;
  gazeX: number;
  gazeY: number;
}

const INITIAL_CAMERA_POSITION = new THREE.Vector3(0, 1.84, 6.45);
const INITIAL_CAMERA_TARGET = new THREE.Vector3(0, 1.58, 0);

export function SaraAvatar3D({ presentation, outputAnalyser, resetCameraToken, onRendererError }: SaraAvatar3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const poseRef = useRef<PoseInput>({
    ...presentation,
    timeSeconds: 0,
    deltaSeconds: 0,
    speakingEnergy: 0,
    blink: 0,
    gazeX: 0,
    gazeY: 0,
  });
  const analyserRef = useRef(outputAnalyser);
  const unavailableRef = useRef(onRendererError);

  poseRef.current = { ...poseRef.current, ...presentation };
  analyserRef.current = outputAnalyser;
  unavailableRef.current = onRendererError;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "low-power",
        premultipliedAlpha: false,
      });
    } catch (error) {
      console.warn("SARA 3D renderer is unavailable in this browser.", error);
      unavailableRef.current("WebGL 3D is unavailable. Try a WebGL-enabled browser or switch to the existing video fallback.");
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 100);
    camera.position.copy(INITIAL_CAMERA_POSITION);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(INITIAL_CAMERA_TARGET);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.minDistance = 4.25;
    controls.maxDistance = 9.25;
    controls.minPolarAngle = Math.PI * 0.32;
    controls.maxPolarAngle = Math.PI * 0.62;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.24;
    controlsRef.current = controls;
    let lastCameraInteraction = performance.now();
    const markInteraction = () => { lastCameraInteraction = performance.now(); };
    controls.addEventListener("start", markInteraction);
    controls.addEventListener("end", markInteraction);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight), false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const ambient = new THREE.HemisphereLight(0xe8f3ff, 0x241727, 2.15);
    ambient.position.set(0, 4, 0);
    scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0xffe1ba, 3.1);
    keyLight.position.set(-3.8, 5.3, 5.4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -3;
    keyLight.shadow.camera.right = 3;
    keyLight.shadow.camera.top = 5;
    keyLight.shadow.camera.bottom = -1;
    keyLight.shadow.bias = -0.0005;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x86b9ff, 1.45);
    fillLight.position.set(3.8, 3.2, 2.4);
    scene.add(fillLight);
    const rimLight = new THREE.DirectionalLight(0xffbd70, 2.6);
    rimLight.position.set(0, 3.0, -3.6);
    scene.add(rimLight);
    const frontLight = new THREE.PointLight(0xf1d8d2, 0.72, 9, 2);
    frontLight.position.set(0, 2.8, 3.6);
    scene.add(frontLight);

    let avatarDriver: ReturnType<typeof createProceduralSaraAvatarDriver>;
    try {
      avatarDriver = createProceduralSaraAvatarDriver();
    } catch (error) {
      renderer.dispose();
      console.error("SARA procedural avatar construction failed.", error);
      unavailableRef.current("The procedural 3D avatar could not be created in this browser.");
      return;
    }
    avatarDriver.root.position.set(0, 0, 0);
    scene.add(avatarDriver.root);

    const resizeObserver = new ResizeObserver(() => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.setSize(width, height, false);
    });
    resizeObserver.observe(canvas);

    const gazePointer = { x: 0, y: 0 };
    const handlePointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      gazePointer.x = THREE.MathUtils.clamp(((event.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
      gazePointer.y = THREE.MathUtils.clamp(((event.clientY - rect.top) / rect.height - 0.45) * 2, -1, 1);
    };
    const handlePointerLeave = () => { gazePointer.x = 0; gazePointer.y = 0; };
    canvas.addEventListener("pointermove", handlePointerMove, { passive: true });
    canvas.addEventListener("pointerleave", handlePointerLeave, { passive: true });

    let animationFrame = 0;
    let contextLost = false;
    let lastTime = performance.now();
    let smoothedEnergy = 0;
    let analyserData: Uint8Array<ArrayBuffer> | null = null;
    let nextBlinkAt = lastTime + 1800 + Math.random() * 2600;
    let blinkStartedAt = 0;
    const handleContextLost = () => {
      contextLost = true;
      window.cancelAnimationFrame(animationFrame);
      unavailableRef.current("The WebGL context was lost. Switch to the video fallback, then try 3D again if the browser has recovered.");
    };
    canvas.addEventListener("webglcontextlost", handleContextLost, false);

    const render = (now: number) => {
      if (contextLost) return;
      animationFrame = window.requestAnimationFrame(render);
      const deltaSeconds = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;
      const pose = poseRef.current;
      pose.timeSeconds = now / 1000;
      pose.deltaSeconds = deltaSeconds;
      pose.gazeX += (gazePointer.x - pose.gazeX) * (1 - Math.exp(-deltaSeconds * 5));
      pose.gazeY += (gazePointer.y - pose.gazeY) * (1 - Math.exp(-deltaSeconds * 5));

      const analyser = analyserRef.current;
      if (pose.state === "speaking" && analyser) {
        if (!analyserData || analyserData.length !== analyser.fftSize) {
          analyserData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
        }
        try {
          analyser.getByteTimeDomainData(analyserData);
          let squareSum = 0;
          for (let index = 0; index < analyserData.length; index += 1) {
            const sample = (analyserData[index] - 128) / 128;
            squareSum += sample * sample;
          }
          const rms = Math.sqrt(squareSum / Math.max(1, analyserData.length));
          const targetEnergy = THREE.MathUtils.clamp((rms - 0.012) * 5.2, 0, 1);
          smoothedEnergy += (targetEnergy - smoothedEnergy) * 0.26;
        } catch {
          smoothedEnergy += (0 - smoothedEnergy) * 0.18;
        }
      } else {
        smoothedEnergy += (0 - smoothedEnergy) * 0.20;
      }
      pose.speakingEnergy = smoothedEnergy;

      let blink = 0;
      if (blinkStartedAt > 0) {
        const blinkProgress = (now - blinkStartedAt) / 190;
        if (blinkProgress >= 1) {
          blinkStartedAt = 0;
          nextBlinkAt = now + 2300 + Math.random() * 3300;
        } else {
          blink = Math.sin(blinkProgress * Math.PI);
        }
      } else if (now >= nextBlinkAt) {
        blinkStartedAt = now;
        blink = 0.02;
      }
      pose.blink = blink;

      avatarDriver.update(pose);
      controls.autoRotate = pose.state === "idle" && now - lastCameraInteraction > 5200;
      controls.update(deltaSeconds);
      renderer.render(scene, camera);
    };
    animationFrame = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      controls.removeEventListener("start", markInteraction);
      controls.removeEventListener("end", markInteraction);
      controls.dispose();
      scene.remove(avatarDriver.root);
      avatarDriver.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      controlsRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    camera.position.copy(INITIAL_CAMERA_POSITION);
    controls.target.copy(INITIAL_CAMERA_TARGET);
    controls.update();
  }, [resetCameraToken]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full touch-none outline-none"
      role="img"
      aria-label={`Interactive three-dimensional SARA companion. ${presentation.state}, ${presentation.expression} expression, ${presentation.gesture} gesture. Drag to rotate; scroll or pinch to zoom.`}
      tabIndex={0}
    />
  );
}
