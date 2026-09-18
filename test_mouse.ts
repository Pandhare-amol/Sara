import { MouseController } from "./src/services/MouseController";

async function main() {
    console.log("Getting initial position...");
    const pos = await MouseController.getPosition();
    console.log("Initial Position:", pos);

    console.log("Moving mouse to (100, 100)...");
    await MouseController.moveTo(100, 100, 0.5);
    
    const newPos = await MouseController.getPosition();
    console.log("New Position:", newPos);
}

main().catch(console.error);
