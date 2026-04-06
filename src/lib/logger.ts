import { COLORS } from "./constants";

const { RED, GREEN, YELLOW, BLUE, CYAN, BOLD, RESET } = COLORS;

function printSuccess(msg: string): void {
    console.error(`${GREEN}${msg}${RESET}`);
}

function printError(msg: string): void {
    console.error(`${RED}${msg}${RESET}`);
}

function printInfo(msg: string): void {
    console.error(`${BLUE}${msg}${RESET}`);
}

function printWarn(msg: string): void {
    console.error(`${YELLOW}${msg}${RESET}`);
}

function printHeader(msg: string): void {
    console.error(`${BOLD}${msg}${RESET}`);
}

function printStep(step: number, total: number, msg: string): void {
    console.error(`${CYAN}[${step}/${total}]${RESET} ${msg}`);
}

export {
    printSuccess,
    printError,
    printInfo,
    printWarn,
    printHeader,
    printStep,
    COLORS,
};
