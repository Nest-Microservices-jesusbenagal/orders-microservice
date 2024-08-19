import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { OrderStatus, PrismaClient } from "@prisma/client";
import { ClientProxy, RpcException } from "@nestjs/microservices";
import { firstValueFrom } from "rxjs";

import {
  ChangeOrderStatusDto,
  CreateOrderDto,
  OrderPaginationDto,
  PaidOrderDto,
} from "./dto";

import { NATS_SERVICE } from "../config";

import {
  type OrderWithProducts,
  type PaymentSession,
  type Product,
} from "./interfaces";

@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger("OrdersService");

  constructor(@Inject(NATS_SERVICE) private readonly client: ClientProxy) {
    super();
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log("Connected to the database");
    } catch (error) {
      this.logger.error("Error connecting to the database", error);
    }
  }

  private async validateProducts(productIds: number[]) {
    const products: Product[] = await firstValueFrom(
      this.client.send({ cmd: "validate_products" }, productIds)
    );

    return products;
  }

  async create(createOrderDto: CreateOrderDto) {
    try {
      // 1. Confirm products exist
      const productIds = createOrderDto.items.map((item) => item.productId);
      const products = await this.validateProducts(productIds);

      // 2. Calculate values
      const totalAmount = createOrderDto.items.reduce((acc, orderItem) => {
        const price = products.find(
          (product) => product.id === orderItem.productId
        ).price;
        return price * orderItem.quantity;
      }, 0);
      const totalItems = createOrderDto.items.reduce((acc, orderItem) => {
        return acc + orderItem.quantity;
      }, 0);

      // 3. Create DB transaction
      const order = await this.order.create({
        data: {
          totalAmount,
          totalItems,
          OrderItem: {
            createMany: {
              data: createOrderDto.items.map((item) => ({
                productId: item.productId,
                quantity: item.quantity,
                price: products.find((product) => product.id === item.productId)
                  .price,
              })),
            },
          },
        },
        include: {
          OrderItem: {
            select: {
              price: true,
              quantity: true,
              productId: true,
            },
          },
        },
      });

      return {
        ...order,
        OrderItem: order.OrderItem.map((item) => ({
          ...item,
          name: products.find((product) => product.id === item.productId).name,
        })),
      };
    } catch (error) {
      throw new RpcException({
        status: HttpStatus.BAD_GATEWAY,
        message: "Check logs",
      });
    }
  }

  async findAll(orderPaginationDto: OrderPaginationDto) {
    const totalPages = await this.order.count({
      where: { status: orderPaginationDto.status },
    });
    const currentPage = orderPaginationDto.page;
    const perPage = orderPaginationDto.limit;

    return {
      data: await this.order.findMany({
        where: { status: orderPaginationDto.status },
        skip: (currentPage - 1) * perPage,
        take: perPage,
      }),
      meta: {
        total: totalPages,
        page: currentPage,
        lastPage: Math.ceil(totalPages / perPage),
      },
    };
  }

  async findOne(id: string) {
    const order = await this.order.findFirst({
      where: { id },
      include: {
        OrderItem: {
          select: {
            price: true,
            quantity: true,
            productId: true,
          },
        },
      },
    });

    const productsIds = order.OrderItem.map((item) => item.productId);
    const products = await this.validateProducts(productsIds);

    if (!order)
      throw new RpcException({
        status: HttpStatus.NOT_FOUND,
        message: `Order with id ${id} not found`,
      });

    return {
      ...order,
      OrderItem: order.OrderItem.map((item) => ({
        ...item,
        name: products.find((product) => product.id === item.productId).name,
      })),
    };
  }

  async changeOrderStatus(changeOrderStatusDto: ChangeOrderStatusDto) {
    const { id, status } = changeOrderStatusDto;

    const order = await this.findOne(id);

    if (order.status === status) return order;

    return this.order.update({
      where: { id },
      data: { status },
    });
  }

  async createPaymentSession(order: OrderWithProducts) {
    const paymentSession: PaymentSession = await firstValueFrom(
      this.client.send("create.payment.session", {
        orderId: order.id,
        currency: "usd",
        items: order.OrderItem.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price,
        })),
      })
    );

    return paymentSession;
  }

  async paidOrder(paidOrderDto: PaidOrderDto) {
    try {
      const order = await this.order.update({
        where: { id: paidOrderDto.orderId },
        data: {
          status: OrderStatus.PAID,
          paid: true,
          paidAt: new Date(),
          stripeChargeId: paidOrderDto.stripePaymentId,
          OrderReceipt: {
            create: {
              receiptUrl: paidOrderDto.receiptUrl,
            },
          },
        },
      });

      this.logger.log(`Order ${order.id} has been paid`);

      return order;
    } catch (error) {
      this.logger.error(error);
      throw new RpcException({
        status: HttpStatus.BAD_GATEWAY,
        message: "Check logs",
      });
    }
  }
}
