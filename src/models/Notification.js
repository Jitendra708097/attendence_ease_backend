module.exports = (sequelize, DataTypes) => {
  const Notification = sequelize.define(
    'Notification',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      type: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      title: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      action_url: DataTypes.STRING,
      is_read: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      read_at: DataTypes.DATE,
    },
    {
      tableName: 'notifications',
      paranoid: true,
      underscored: true,
      indexes: [
        {
          fields: ['is_read'],
          where: { is_read: false },
        },
      ],
    }
  );

  Notification.associate = (models) => {
    Notification.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    Notification.belongsTo(models.Employee, { foreignKey: 'emp_id', as: 'employee' });
  };

  return Notification;
};
